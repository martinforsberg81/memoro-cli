#!/usr/bin/env node
import { collectDashboard, renderDashboard } from '../src/mc/admin-dashboard.js';

const result = await collectDashboard({ token: process.env.ADMIN_TOKEN });
const json = process.argv.slice(2).includes('--json');
process.stdout.write(json ? `${JSON.stringify(result.model)}\n` : `${renderDashboard(result.model)}\n`);
process.exitCode = result.exitCode;
