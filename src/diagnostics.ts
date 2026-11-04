import { allRecords, DB_VERSION, getMeta, pendingOps } from './storage'
import type { SyncDiagnostic } from './sync'

export const CLIENT_BUILD = import.meta.env.VITE_APP_BUILD ?? 'development'

/** Explicit whitelist: no passwords, cookies, record content or API response bodies. */
export async function syncDiagnosticReport(): Promise<string> {
  const [records, operations, error, lastSyncAt, startedAt, username, cursor] = await Promise.all([
    allRecords(), pendingOps(), getMeta<SyncDiagnostic | null>('lastSyncError'),
    getMeta<string>('lastSyncAt'), getMeta<string>('syncStartedAt'),
    getMeta<string>('username'), getMeta<number>('syncCursor')
  ])
  return [
    'WorkLog 同步诊断',
    `生成时间：${new Date().toISOString()}`,
    `账号：${username ?? '未记录，请补充用户名'}`,
    `客户端构建：${CLIENT_BUILD}`,
    `本地数据库版本：${DB_VERSION}`,
    `站点：${typeof location === 'undefined' ? 'unknown' : location.origin}`,
    `网络：${typeof navigator === 'undefined' ? 'unknown' : navigator.onLine ? '在线' : '离线'}`,
    `浏览器：${typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent}`,
    `本机记录数：${records.filter(record => !record.deletedAt).length}`,
    `待上传操作数：${operations.length}`,
    `同步游标：${cursor ?? 0}`,
    `最近尝试：${startedAt ?? '无'}`,
    `最近成功：${lastSyncAt ?? '无'}`,
    `失败时间：${error?.at ?? '无'}`,
    `失败环节：${error ? { local: '处理本机数据', push: '上传记录', pull: '下载记录', rebuild: '云端重建' }[error.stage] ?? '旧版本未记录' : '无'}`,
    `错误代码：${error?.code ?? '无'}`,
    `HTTP 状态：${error?.status ?? '未收到或未记录'}`,
    `请求编号：${error?.requestId ?? '未收到或旧版服务端未提供'}`,
    `Cloudflare Ray：${error?.cfRay ?? '无'}`,
    `服务端接口版本：${error?.serverApi ?? '旧版本或未连接'}`,
    `关联记录编号：${error?.recordId ?? '无'}`,
    '此报告不包含密码、登录凭据或工作内容。'
  ].join('\n')
}
