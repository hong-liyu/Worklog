<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { registerSW } from 'virtual:pwa-register'
import { ChevronLeft, ChevronRight, MoreVertical, Plus, RefreshCw } from '@lucide/vue'
import CalendarMonth from './components/CalendarMonth.vue'
import DaySheet from './components/DaySheet.vue'
import RecordForm from './components/RecordForm.vue'
import SettingsSheet from './components/SettingsSheet.vue'
import LoginView from './views/LoginView.vue'
import { syncDiagnosticReport } from './diagnostics'
import { logout, request } from './api'
import { formatHours, formatSalary, localDate, monthlySummary, toCSV, type RecordInput, type RecordType, type WorkLocation } from './domain'
import {
  allRecords,
  clearLocalData,
  deleteRecord,
  getMeta,
  pendingCount,
  saveRecord,
  setMeta,
  type LocalRecord
} from './storage'
import { rebuildFromServer, syncNow, type SyncState } from './sync'

type Phase = 'loading' | 'login' | 'ready'
type Sheet = 'detail' | 'form' | 'settings' | null

const initial = new Date()
const phase = ref<Phase>('loading')
const today = ref(localDate(initial))
const view = ref({ year: initial.getFullYear(), month: initial.getMonth() + 1 })
const records = ref<LocalRecord[]>([])
const sheet = ref<Sheet>(null)
const selectedDate = ref(today.value)
const editing = ref<LocalRecord>()
const formType = ref<RecordType>('duty')
const fromDetail = ref(false)
const lastLocation = ref<WorkLocation>('art_center')
const message = ref('')
const updateReady = ref(false)
const diagnosticReport = ref('')
const diagnosticMessage = ref('')
const syncing = ref(false)
const state = ref<SyncState>({ phase: 'idle', pending: 0 })

let retries = 0
let retryTimer: number | undefined
let disposed = false

const monthKey = computed(() => `${view.value.year}-${String(view.value.month).padStart(2, '0')}`)
const summary = computed(() => monthlySummary(records.value, monthKey.value))
const dayRecords = computed(() =>
  records.value.filter(record => !record.deletedAt && record.workDate === selectedDate.value)
)

const syncLabel = computed(() => {
  if (syncing.value) return '正在同步…'
  switch (state.value.phase) {
    case 'synced':
      return '已同步'
    case 'pending':
      return `等待同步（${state.value.pending}）`
    case 'offline':
      return '离线中，记录已保存在本机'
    case 'failed':
      return '同步失败，请在设置查看原因'
    case 'conflict':
      return '存在数据冲突，已保留本机修改'
    case 'unauthorized':
      return '登录已失效，请重新登录'
    default:
      return '正在检查同步状态…'
  }
})

const updateSW = registerSW({
  onNeedRefresh: () => {
    updateReady.value = true
  }
})

function notify(text: string): void {
  message.value = text
  window.setTimeout(() => {
    if (message.value === text) message.value = ''
  }, 2600)
}

async function refresh(): Promise<void> {
  records.value = await allRecords()
}

async function synchronize(): Promise<void> {
  if (phase.value !== 'ready' || disposed) return
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer)
    retryTimer = undefined
  }
  syncing.value = true
  try {
    state.value = await syncNow()
  } finally {
    syncing.value = false
  }
  await refresh()
  if (sheet.value === 'settings') await loadDiagnostics()

  if (state.value.phase === 'unauthorized') {
    phase.value = 'login'
    return
  }
  if (state.value.phase === 'synced' || state.value.phase === 'conflict') {
    retries = 0
    return
  }
  if (typeof navigator !== 'undefined' && navigator.onLine && retries < 5) {
    const delay = Math.min(30_000, 1000 * 2 ** retries)
    retries += 1
    retryTimer = window.setTimeout(() => {
      void synchronize()
    }, delay)
  }
}

async function enterApp(): Promise<void> {
  await refresh()
  lastLocation.value = (await getMeta<WorkLocation>('lastLocation')) ?? 'art_center'
  void synchronize()
}

async function bootstrap(): Promise<void> {
  let response: Response | null = null
  try {
    response = await request('/auth/me')
  } catch {
    response = null
  }

  if (response?.ok) {
    phase.value = 'ready'
    try {
      const body = await response.json() as { user?: { username?: string } }
      if (body.user?.username) await setMeta('username', body.user.username)
    } catch { /* Account label is optional for older servers. */ }
  }
  else if (response && response.status === 401) phase.value = 'login'
  else phase.value = (await getMeta('lastLoginAt')) ? 'ready' : 'login'

  if (phase.value === 'ready') await enterApp()
}

function changeMonth(delta: number): void {
  const shifted = new Date(view.value.year, view.value.month - 1 + delta, 1)
  view.value = { year: shifted.getFullYear(), month: shifted.getMonth() + 1 }
}

function goCurrentMonth(): void {
  const now = new Date()
  view.value = { year: now.getFullYear(), month: now.getMonth() + 1 }
}

function openDetail(date: string): void {
  selectedDate.value = date
  sheet.value = 'detail'
}

function openForm(date: string, record?: LocalRecord, originDetail = false, recordType: RecordType = 'duty'): void {
  today.value = localDate(new Date())
  selectedDate.value = date
  editing.value = record
  formType.value = record?.recordType ?? recordType
  fromDetail.value = originDetail
  sheet.value = 'form'
}

function closeForm(): void {
  sheet.value = fromDetail.value ? 'detail' : null
  editing.value = undefined
}

async function commit(input: RecordInput, existing?: LocalRecord): Promise<void> {
  await saveRecord(input, existing)
  if (input.location) {
    lastLocation.value = input.location
    await setMeta('lastLocation', input.location)
  }
  await refresh()
  closeForm()
  notify('已保存到本机，联网后自动同步')
  void synchronize()
}

async function remove(record: LocalRecord): Promise<void> {
  await deleteRecord(record)
  await refresh()
  sheet.value = 'detail'
  editing.value = undefined
  notify('已在本机删除')
  void synchronize()
}

function exportCSV(): void {
  const csv = toCSV(records.value)
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `工时记录-${today.value}.csv`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  sheet.value = null
  notify('CSV 已导出')
}

async function loadDiagnostics(): Promise<void> {
  try {
    diagnosticReport.value = await syncDiagnosticReport()
    const error = await getMeta<{ message?: string } | null>('lastSyncError')
    diagnosticMessage.value = error?.message ?? ''
  } catch {
    diagnosticMessage.value = '无法读取本机存储，请保留当前浏览器并联系管理员'
    diagnosticReport.value = `WorkLog 同步诊断\n本机存储无法读取\n浏览器：${navigator.userAgent}`
  }
}

async function openSettings(): Promise<void> {
  sheet.value = 'settings'
  await loadDiagnostics()
}

async function copyDiagnostics(): Promise<void> {
  await loadDiagnostics()
  try {
    await navigator.clipboard.writeText(diagnosticReport.value)
    notify('诊断已复制，可发给管理员')
  } catch { notify('无法复制，请使用下载诊断') }
}

async function downloadDiagnostics(): Promise<void> {
  await loadDiagnostics()
  const url = URL.createObjectURL(new Blob([diagnosticReport.value], { type: 'text/plain;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `worklog-sync-diagnostic-${localDate(new Date())}.txt`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function manualSync(): Promise<void> {
  retries = 0
  await synchronize()
  notify(state.value.phase === 'synced' ? '已同步' : syncLabel.value)
}

async function rebuild(): Promise<void> {
  const pending = await pendingCount()
  const warning =
    pending > 0
      ? `本机还有 ${pending} 条未同步修改，重建会丢弃它们。确定继续？`
      : '将用云端数据覆盖本机缓存，确定继续？'
  if (!window.confirm(warning)) return
  sheet.value = null
  const result = await rebuildFromServer()
  state.value = result
  await refresh()
  notify(result.phase === 'synced' ? '已按云端数据重建' : '重建失败，请检查网络')
}

async function handleLogout(): Promise<void> {
  const pending = await pendingCount()
  if (pending > 0 && !window.confirm(`仍有 ${pending} 条未同步记录，退出将清除本机数据。仍要退出吗？`)) return
  sheet.value = null
  try {
    await logout()
  } catch {
    // 网络不通也要允许本机退出，服务器会话到期后自然失效。
  }
  await clearLocalData()
  records.value = []
  state.value = { phase: 'idle', pending: 0 }
  phase.value = 'login'
}

async function onLoggedIn(): Promise<void> {
  phase.value = 'ready'
  await enterApp()
}

function onOnline(): void {
  retries = 0
  void synchronize()
}

function onVisibility(): void {
  if (document.visibilityState !== 'visible') return
  retries = 0
  today.value = localDate(new Date())
  void synchronize()
}

onMounted(() => {
  void bootstrap()
  window.addEventListener('online', onOnline)
  document.addEventListener('visibilitychange', onVisibility)
})

onUnmounted(() => {
  disposed = true
  if (retryTimer !== undefined) clearTimeout(retryTimer)
  window.removeEventListener('online', onOnline)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <LoginView v-if="phase === 'login'" @success="onLoggedIn" />

  <div v-else-if="phase === 'loading'" class="boot">
    <div class="boot-mark">工</div>
  </div>

  <main v-else class="app-shell">
    <div class="month-nav">
      <button class="icon-button" type="button" aria-label="上个月" @click="changeMonth(-1)">
        <ChevronLeft :size="23" />
      </button>
      <button class="month-title" type="button" title="返回当前月份" @click="goCurrentMonth">
        {{ view.year }}年{{ view.month }}月
      </button>
      <button class="icon-button" type="button" aria-label="下个月" @click="changeMonth(1)">
        <ChevronRight :size="23" />
      </button>
      <button class="icon-button nav-settings" type="button" aria-label="设置" @click="openSettings">
        <MoreVertical :size="22" />
      </button>
    </div>

    <section class="summary-card">
      <div class="summary-main">
        <div class="summary-label">本月累计</div>
        <strong>{{ formatHours(summary.totalMinutes) }}</strong>
      </div>
      <div class="summary-pay">
        <div class="summary-label">本月工资</div>
        <strong>{{ formatSalary(summary.totalMinutes) }}</strong>
      </div>
      <div class="summary-breakdown">
        <div class="summary-metric"><span>值班</span><strong>{{ formatHours(summary.dutyMinutes) }}</strong></div>
        <div class="summary-metric"><span>加班</span><strong>{{ formatHours(summary.overtimeMinutes) }}</strong></div>
      </div>
    </section>

    <div class="legend">
      <span><i class="swatch art"></i>艺术中心</span>
      <span><i class="swatch sutuo"></i>素拓</span>
      <span><i class="swatch overtime"></i>独立加班</span>
    </div>

    <CalendarMonth
      :year="view.year"
      :month="view.month"
      :records="records"
      :today="today"
      @select="openDetail"
    />

    <p class="sync-note" role="status">
      <span class="status-dot" :class="state.phase"></span>{{ syncLabel }}
    </p>

    <div class="bottom-action record-actions">
      <button class="primary-button" type="button" @click="openForm(localDate(new Date()))">
        <Plus :size="20" /> 值班记录
      </button>
      <button class="primary-button overtime-button" type="button" @click="openForm(localDate(new Date()), undefined, false, 'overtime')">
        <Plus :size="20" /> 加班记录
      </button>
    </div>

    <DaySheet
      v-if="sheet === 'detail'"
      :date="selectedDate"
      :records="dayRecords"
      :on-delete="remove"
      @close="sheet = null"
      @add="(date, type) => openForm(date, undefined, true, type)"
      @edit="record => openForm(record.workDate, record, true)"
    />

    <SettingsSheet
      v-if="sheet === 'settings'"
      :sync-label="syncLabel"
      :diagnostic-report="diagnosticReport"
      :diagnostic-message="diagnosticMessage"
      :pending="state.pending"
      :busy="syncing"
      @close="sheet = null"
      @export-csv="exportCSV"
      @copy-diagnostics="copyDiagnostics"
      @download-diagnostics="downloadDiagnostics"
      @sync="manualSync"
      @rebuild="rebuild"
      @logout="handleLogout"
    />

    <RecordForm
      v-if="sheet === 'form'"
      :key="editing?.id ?? `new-${selectedDate}-${formType}`"
      :record-type="formType"
      :date="selectedDate"
      :record="editing"
      :last-location="lastLocation"
      :on-save="commit"
      :on-delete="remove"
      :on-close="closeForm"
    />

    <div v-if="message" class="toast" role="status">{{ message }}</div>

    <div v-if="updateReady" class="update-notice">
      <span>有新版本可用</span>
      <button type="button" @click="updateSW()"><RefreshCw :size="15" /> 重新加载</button>
    </div>
  </main>
</template>
