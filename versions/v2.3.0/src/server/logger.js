// logger.js — Debug 版日志：工作日志(work-日期.log) + 报错日志(error-日期.log)
// 同步追加写盘，进程异常退出也不丢日志；日志目录可用 LOG_DIR 环境变量覆盖
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const logDir = process.env.LOG_DIR || join(process.cwd(), 'temp', 'logs');
try { mkdirSync(logDir, { recursive: true }); } catch { /* 目录不可建时只打控制台 */ }

const bom = '\ufeff';
const ensured = new Set();
function ensureBom(file) {
  if (ensured.has(file)) return;
  ensured.add(file);
  try {
    if (!existsSync(file)) {
      appendFileSync(file, bom, 'utf8');
      return;
    }
    if (readFileSync(file, 'utf8').charAt(0) !== '\ufeff') {
      const body = readFileSync(file, 'utf8');
      writeFileSync(file, bom + body, 'utf8'); // 旧日志补 BOM，避免中文被按 ANSI 读成问号
    }
  } catch { /* 日志编码修复失败不阻塞 */ }
}
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 23);
const day = () => new Date().toISOString().slice(0, 10);

function fmt(args) {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ''}`;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

function emit(kind, tag, args) {
  const line = `[${stamp()}] [${tag}] ${fmt(args)}`;
  if (kind === 'error') console.error(line); else console.log(line);
  const logFile = join(logDir, `${kind}-${day()}.log`);
  try {
    ensureBom(logFile);
    appendFileSync(logFile, line + '\n', 'utf8');
  } catch { /* 忽略写盘失败 */ }
}

export const logger = {
  /** 工作日志：服务器生命周期、房间/成员/连接等关键事件 */
  work: (...args) => emit('work', 'INFO', args),
  /** 报错日志：服务器异常 + 客户端上报的 JS 错误 */
  error: (...args) => emit('error', 'ERROR', args),
  /** 调试日志：信令/HTTP 明细，NODE_ENV=debug 或 DEBUG_LOG=1 时写入工作日志 */
  debug: (...args) => {
    if (process.env.NODE_ENV === 'debug' || process.env.DEBUG_LOG === '1') emit('work', 'DEBUG', args);
  },
};
