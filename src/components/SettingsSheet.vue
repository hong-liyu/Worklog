<script setup lang="ts">
import { CloudDownload, LogOut, RotateCw, RefreshCw, X } from '@lucide/vue'

defineProps<{ syncLabel: string; diagnosticReport: string; diagnosticMessage: string; pending: number; busy: boolean }>()
const emit = defineEmits<{ close: []; exportCsv: []; copyDiagnostics: []; downloadDiagnostics: []; sync: []; rebuild: []; logout: [] }>()
</script>

<template>
  <div class="sheet-overlay" @click.self="emit('close')">
    <section class="sheet" role="dialog" aria-modal="true" aria-label="设置">
      <div class="sheet-scroll">
        <div class="sheet-handle"></div>
        <div class="sheet-heading">
          <h2>设置</h2>
          <button class="icon-button" type="button" aria-label="关闭" @click="emit('close')"><X :size="22" /></button>
        </div>

        <div class="settings-status">
          <span class="status-dot" :class="{ waiting: pending > 0 }"></span>
          <span>{{ syncLabel }}</span>
        </div>

        <button class="settings-row" type="button" @click="emit('exportCsv')">
          <CloudDownload :size="19" /><span>导出 CSV</span>
        </button>
        <button class="settings-row" type="button" :disabled="busy" @click="emit('sync')">
          <RefreshCw :size="19" /><span>立即同步</span>
        </button>
        <button class="settings-row" type="button" :disabled="busy" @click="emit('rebuild')">
          <RotateCw :size="19" /><span>从云端重建本机数据</span>
        </button>
        <button class="settings-row danger" type="button" @click="emit('logout')">
          <LogOut :size="19" /><span>退出登录</span>
        </button>

        <details class="sync-diagnostics" :open="!!diagnosticMessage">
          <summary>同步诊断（提供给管理员）</summary>
          <p v-if="diagnosticMessage" class="form-error" role="alert">{{ diagnosticMessage }}</p>
          <textarea class="diagnostic-report" aria-label="同步诊断报告" :value="diagnosticReport" readonly rows="8"></textarea>
          <div class="segments">
            <button type="button" @click="emit('copyDiagnostics')">复制诊断</button>
            <button type="button" @click="emit('downloadDiagnostics')">下载诊断</button>
          </div>
        </details>

        <p class="settings-note">
          「从云端重建」会清空本机缓存，用于数据对不上或换设备时重新拉取。本机尚未同步的修改会先被提示。
        </p>
      </div>
    </section>
  </div>
</template>
