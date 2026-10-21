// pane-host 的文件位置。PANE_HOST_DIR 只给测试用（换一个目录起一套互不干扰的 socket / 日志）
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOME = os.homedir()
export const RUN_DIR = process.env.PANE_HOST_DIR || path.join(HOME, '.cache/pane-remote-host')
export const SOCK = path.join(RUN_DIR, 'host.sock')
export const LOG = path.join(RUN_DIR, 'host.log')
export const HOST_ROOT = path.dirname(fileURLToPath(import.meta.url)) // 仓库里的 host/
export const REPO = path.dirname(HOST_ROOT)
export const STATE = process.env.PANE_REMOTE_STATE || path.join(HOME, '.local/state/pane-remote')
