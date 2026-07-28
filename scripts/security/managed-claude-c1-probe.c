#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach/mach.h>
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

static bool wait_for_child(pid_t pid) {
  int status = 0;
  for (int attempt = 0; attempt < 300; attempt += 1) {
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
  return wait_for_child(pid);
}

static bool process_exposes_marker(const char *pid_value, const char *marker) {
  if (pid_value == NULL || marker == NULL || pid_value[0] == '\0') return false;
  int pipefd[2];
  if (pipe(pipefd) != 0) return false;
  pid_t pid = fork();
  if (pid < 0) {
    close(pipefd[0]);
    close(pipefd[1]);
    return false;
  }
  if (pid == 0) {
    dup2(pipefd[1], STDOUT_FILENO);
    int devnull = open("/dev/null", O_WRONLY);
    if (devnull >= 0) dup2(devnull, STDERR_FILENO);
    close(pipefd[0]);
    close(pipefd[1]);
    char *const argv[] = {
      "/bin/ps", "eww", "-p", (char *)pid_value, "-o", "command=", NULL
    };
    execve("/bin/ps", argv, environ);
    _exit(127);
  }
  close(pipefd[1]);
  char buffer[16384];
  ssize_t used = 0;
  while (used < (ssize_t)sizeof(buffer) - 1) {
    ssize_t count = read(pipefd[0], buffer + used, sizeof(buffer) - 1 - (size_t)used);
    if (count <= 0) break;
    used += count;
  }
  close(pipefd[0]);
  bool ok = wait_for_child(pid);
  buffer[used > 0 ? used : 0] = '\0';
  return ok && strstr(buffer, marker) != NULL;
}

static pid_t parse_pid(const char *pid_value) {
  if (pid_value == NULL || pid_value[0] == '\0') return -1;
  char *end = NULL;
  long parsed = strtol(pid_value, &end, 10);
  if (end == pid_value || *end != '\0' || parsed <= 0 || parsed > INT_MAX) {
    return -1;
  }
  return (pid_t)parsed;
}

static bool observer_task_port_reachable(const char *pid_value) {
  pid_t pid = parse_pid(pid_value);
  if (pid <= 0) return false;
  mach_port_t task = MACH_PORT_NULL;
  kern_return_t result = task_for_pid(mach_task_self(), pid, &task);
  if (result != KERN_SUCCESS || task == MACH_PORT_NULL) return false;
  mach_port_deallocate(mach_task_self(), task);
  return true;
}

static bool observer_signal_reachable(const char *pid_value) {
  pid_t pid = parse_pid(pid_value);
  return pid > 0 && kill(pid, 0) == 0;
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

static bool can_connect_ipv4(const char *ip, int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return false;
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);
  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)port);
  if (inet_pton(AF_INET, ip, &address.sin_addr) != 1) {
    close(fd);
    return false;
  }
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
  return result == 0;
}

static bool workspace_write_blocked(void) {
  char path[96];
  snprintf(path, sizeof(path), ".mc-c1-write-probe-%d", getpid());
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) return true;
  bool blocked = write(fd, "ok", 2) != 2;
  close(fd);
  if (unlink(path) != 0) blocked = true;
  return blocked;
}

/*
 * Leave the inherited process group and repeat every credential-relevant
 * boundary check available to this native probe. A true result means that
 * process-group escape also escaped the credential boundary.
 */
static bool detached_boundary_reachable(
  const char *canary_path,
  const char *socket_path,
  const char *loopback_port
) {
  pid_t pid = fork();
  if (pid < 0) return false;
  if (pid == 0) {
    if (setsid() < 0) _exit(1);
    bool reached = access(canary_path, R_OK) == 0
      || getenv("MC_C1_CANARY") != NULL
      || getenv("CLAUDE_CODE_OAUTH_TOKEN") != NULL
      || can_connect_unix(socket_path)
      || can_connect_ipv4("127.0.0.1", atoi(loopback_port))
      || can_connect_ipv4("1.1.1.1", 443);
    _exit(reached ? 0 : 1);
  }
  return wait_for_child(pid);
}

static const char *json_bool(bool value) {
  return value ? "true" : "false";
}

static bool read_public_observer_pid(char *buffer, size_t size) {
  int fd = open("public-observer-pid", O_RDONLY);
  if (fd < 0) return false;
  ssize_t count = read(fd, buffer, size - 1);
  close(fd);
  if (count <= 0) return false;
  buffer[count] = '\0';
  buffer[strcspn(buffer, "\r\n")] = '\0';
  return buffer[0] != '\0';
}

static bool run_any_host_mc(bool via_node) {
  const char *roots[] = { "/opt/homebrew/bin", "/usr/local/bin" };
  for (size_t index = 0; index < sizeof(roots) / sizeof(roots[0]); index += 1) {
    char mc_path[256];
    char node_path[256];
    snprintf(mc_path, sizeof(mc_path), "%s/mc", roots[index]);
    snprintf(node_path, sizeof(node_path), "%s/node", roots[index]);
    if (via_node) {
      char *const argv[] = {
        node_path, mc_path, "vault", "--help", NULL
      };
      if (run_quiet(node_path, argv)) return true;
    } else {
      char *const argv[] = {
        mc_path, "vault", "--help", NULL
      };
      if (run_quiet(mc_path, argv)) return true;
    }
  }
  return false;
}

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "--observe") == 0) {
    sleep(60);
    return 0;
  }
  bool executor_mode = argc == 2;
  if (!executor_mode && argc != 10 && argc != 11) return 2;
  char executor_observer_pid[32] = "";
  if (executor_mode && !read_public_observer_pid(
    executor_observer_pid,
    sizeof(executor_observer_pid)
  )) return 3;
  const char *canary_path = executor_mode
    ? "../credential-domain/canary"
    : argv[1];
  const char *socket_path = executor_mode
    ? "../credential-domain/credential.sock"
    : argv[2];
  const char *loopback_port = executor_mode ? argv[1] : argv[3];
  const char *observer_pid = executor_mode ? executor_observer_pid : argv[4];
  const char *host_mc_bin = executor_mode ? NULL : argv[5];
  const char *host_node_bin = executor_mode ? NULL : argv[6];
  const char *host_mc_entry = executor_mode ? NULL : argv[7];
  const char *synthetic_keychain_path = executor_mode
    ? "../credential-domain/synthetic.keychain-db"
    : argv[8];
  const char *synthetic_keychain_service = executor_mode
    ? "mc-c1-executor"
    : argv[9];

  bool canary_in_argv = false;
  for (int index = 0; index < argc; index += 1) {
    if (strstr(argv[index], "MC_C1_CANARY=") != NULL) canary_in_argv = true;
  }
  bool provider_capability_in_environment =
    getenv("CLAUDE_CODE_OAUTH_TOKEN") != NULL;

  char *const vault_bin_argv[] = {
    (char *)host_mc_bin, "vault", "--help", NULL
  };
  char *const vault_node_argv[] = {
    (char *)host_node_bin, (char *)host_mc_entry, "vault", "--help", NULL
  };
  char *const synthetic_keychain_argv[] = {
    "/usr/bin/security",
    "find-generic-password",
    "-a", "mc-c1",
    "-s", (char *)synthetic_keychain_service,
    "-w",
    (char *)synthetic_keychain_path,
    NULL
  };

  printf(
    "{\"schema\":1,"
    "\"file_readable\":%s,"
    "\"canary_in_environment\":%s,"
    "\"provider_capability_in_environment\":%s,"
    "\"canary_in_argv\":%s,"
    "\"observer_process_exposes_canary\":%s,"
    "\"observer_task_port_reachable\":%s,"
    "\"observer_signal_reachable\":%s,"
    "\"detached_boundary_reachable\":%s,"
    "\"credential_socket_reachable\":%s,"
    "\"loopback_reachable\":%s,"
    "\"external_network_reachable\":%s,"
    "\"workspace_write_blocked\":%s,"
    "\"vault_admin_via_bin_callable\":%s,"
    "\"vault_admin_via_node_callable\":%s,"
    "\"synthetic_keychain_secret_readable\":%s}\n",
    json_bool(access(canary_path, R_OK) == 0),
    json_bool(getenv("MC_C1_CANARY") != NULL),
    json_bool(provider_capability_in_environment),
    json_bool(canary_in_argv),
    json_bool(process_exposes_marker(observer_pid, "MC_C1_OBSERVER_CANARY=")),
    json_bool(observer_task_port_reachable(observer_pid)),
    json_bool(observer_signal_reachable(observer_pid)),
    json_bool(detached_boundary_reachable(canary_path, socket_path, loopback_port)),
    json_bool(can_connect_unix(socket_path)),
    json_bool(can_connect_ipv4("127.0.0.1", atoi(loopback_port))),
    json_bool(can_connect_ipv4("1.1.1.1", 443)),
    json_bool(workspace_write_blocked()),
    json_bool(executor_mode
      ? run_any_host_mc(false)
      : run_quiet(host_mc_bin, vault_bin_argv)),
    json_bool(executor_mode
      ? run_any_host_mc(true)
      : run_quiet(host_node_bin, vault_node_argv)),
    json_bool(run_quiet("/usr/bin/security", synthetic_keychain_argv))
  );
  return 0;
}
