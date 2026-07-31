#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static bool wait_for_child(pid_t pid, int attempts) {
  int status = 0;
  for (int attempt = 0; attempt < attempts; attempt += 1) {
    pid_t result = waitpid(pid, &status, WNOHANG);
    if (result == pid) return WIFEXITED(status) && WEXITSTATUS(status) == 0;
    if (result < 0) return false;
    usleep(100000);
  }
  kill(pid, SIGKILL);
  waitpid(pid, &status, 0);
  return false;
}

static bool run_quiet(const char *path, char *const argv[]) {
  pid_t pid = fork();
  if (pid < 0) return false;
  if (pid == 0) {
    int devnull = open("/dev/null", O_RDWR);
    if (devnull >= 0) {
      dup2(devnull, STDIN_FILENO);
      dup2(devnull, STDOUT_FILENO);
      dup2(devnull, STDERR_FILENO);
      if (devnull > STDERR_FILENO) close(devnull);
    }
    execve(path, argv, environ);
    _exit(127);
  }
  /*
   * A cold Node CLI start can exceed two seconds on a busy developer
   * machine. This probe checks callability, not latency, so keep a bounded
   * five-second budget for CLI and curl children.
   */
  return wait_for_child(pid, 50);
}

static bool parent_exposes_canary(void) {
  int pipefd[2];
  if (pipe(pipefd) != 0) return false;
  pid_t pid = fork();
  if (pid < 0) {
    close(pipefd[0]);
    close(pipefd[1]);
    return false;
  }
  if (pid == 0) {
    char parent_pid[32];
    snprintf(parent_pid, sizeof(parent_pid), "%d", getppid());
    dup2(pipefd[1], STDOUT_FILENO);
    int devnull = open("/dev/null", O_WRONLY);
    if (devnull >= 0) dup2(devnull, STDERR_FILENO);
    close(pipefd[0]);
    close(pipefd[1]);
    char *const argv[] = {
      "/bin/ps", "eww", "-p", parent_pid, "-o", "command=", NULL
    };
    execve("/bin/ps", argv, environ);
    _exit(127);
  }
  close(pipefd[1]);
  char buffer[8192];
  ssize_t used = 0;
  while (used < (ssize_t)sizeof(buffer) - 1) {
    ssize_t count = read(pipefd[0], buffer + used, sizeof(buffer) - 1 - (size_t)used);
    if (count <= 0) break;
    used += count;
  }
  close(pipefd[0]);
  bool ok = wait_for_child(pid, 20);
  buffer[used > 0 ? used : 0] = '\0';
  return ok && strstr(buffer, "MC_BOUNDARY_CANARY=") != NULL;
}

static bool can_connect_unix(const char *path) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return false;
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  if (strlen(path) >= sizeof(address.sun_path)) {
    close(fd);
    return false;
  }
  strncpy(address.sun_path, path, sizeof(address.sun_path) - 1);
  bool connected = connect(fd, (struct sockaddr *)&address, sizeof(address)) == 0;
  close(fd);
  return connected;
}

static bool can_connect_external(void) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return false;
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);
  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons(443);
  inet_pton(AF_INET, "1.1.1.1", &address.sin_addr);
  int result = connect(fd, (struct sockaddr *)&address, sizeof(address));
  if (result != 0 && errno == EINPROGRESS) {
    fd_set writable;
    FD_ZERO(&writable);
    FD_SET(fd, &writable);
    struct timeval timeout = { .tv_sec = 0, .tv_usec = 750000 };
    result = select(fd + 1, NULL, &writable, NULL, &timeout);
    if (result > 0) {
      int error = 0;
      socklen_t length = sizeof(error);
      getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length);
      result = error == 0 ? 0 : -1;
    } else {
      result = -1;
    }
  }
  close(fd);
  if (result == 0) return true;

  /*
   * Permission profiles with domain rules intentionally route public traffic
   * through Codex's sandbox proxy and block raw destination sockets. Use the
   * platform curl through that injected proxy as the positive egress check.
   */
  char *const curl_argv[] = {
    "/usr/bin/curl",
    "--silent",
    "--show-error",
    "--fail",
    "--max-time",
    "5",
    "https://1.1.1.1/cdn-cgi/trace",
    NULL
  };
  return run_quiet("/usr/bin/curl", curl_argv);
}

static bool workspace_write_blocked(void) {
  char path[96];
  snprintf(path, sizeof(path), ".mc-boundary-write-probe-%d", getpid());
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) return true;
  bool blocked = write(fd, "ok", 2) != 2;
  close(fd);
  if (unlink(path) != 0) blocked = true;
  return blocked;
}

/*
 * Detachment must not restore credential access. Ordinary network access is
 * measured separately and remains available in the credential-only profile.
 */
static bool detached_boundary_reachable(
  const char *canary_path,
  const char *socket_path
) {
  pid_t pid = fork();
  if (pid < 0) return false;
  if (pid == 0) {
    if (setsid() < 0) _exit(1);
    bool reached = access(canary_path, R_OK) == 0
      || getenv("MC_BOUNDARY_CANARY") != NULL
      || can_connect_unix(socket_path);
    _exit(reached ? 0 : 1);
  }
  return wait_for_child(pid, 20);
}

static const char *json_bool(bool value) {
  return value ? "true" : "false";
}

int main(int argc, char **argv) {
  if (argc < 6) return 2;
  const char *canary_path = argv[1];
  const char *socket_path = argv[2];
  const char *host_mc_bin = argv[3];
  const char *host_node_bin = argv[4];
  const char *host_mc_entry = argv[5];

  bool file_readable = access(canary_path, R_OK) == 0;
  bool canary_in_environment = getenv("MC_BOUNDARY_CANARY") != NULL;
  bool canary_in_argv = false;
  for (int index = 0; index < argc; index += 1) {
    if (strstr(argv[index], "MC_BOUNDARY_CANARY=") != NULL) canary_in_argv = true;
  }

  char *const vault_bin_argv[] = {
    (char *)host_mc_bin, "vault", "--help", NULL
  };
  char *const vault_node_argv[] = {
    (char *)host_node_bin, (char *)host_mc_entry, "vault", "--help", NULL
  };
  printf(
    "{\"schema\":1,"
    "\"file_readable\":%s,"
    "\"canary_in_environment\":%s,"
    "\"canary_in_argv\":%s,"
    "\"parent_process_exposes_canary\":%s,"
    "\"detached_boundary_reachable\":%s,"
    "\"credential_socket_reachable\":%s,"
    "\"external_network_reachable\":%s,"
    "\"workspace_write_blocked\":%s,"
    "\"vault_admin_via_bin_callable\":%s,"
    "\"vault_admin_via_node_callable\":%s}\n",
    json_bool(file_readable),
    json_bool(canary_in_environment),
    json_bool(canary_in_argv),
    json_bool(parent_exposes_canary()),
    json_bool(detached_boundary_reachable(canary_path, socket_path)),
    json_bool(can_connect_unix(socket_path)),
    json_bool(can_connect_external()),
    json_bool(workspace_write_blocked()),
    json_bool(run_quiet(host_mc_bin, vault_bin_argv)),
    json_bool(run_quiet(host_node_bin, vault_node_argv))
  );
  return 0;
}
