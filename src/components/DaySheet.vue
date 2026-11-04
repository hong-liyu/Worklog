<script setup lang="ts">
import { computed, ref } from 'vue'
import { Plus, Trash2, X } from '@lucide/vue'
import { endTime, formatHours, LOCATION_LABEL, type RecordType, type WorkRecord } from '../domain'
import type { LocalRecord } from '../storage'

const props = defineProps<{ date: string; records: LocalRecord[]; onDelete: (record: LocalRecord) => Promise<void> }>()
const deleting = ref<string | null>(null)
const error = ref('')
const emit = defineEmits<{ close: []; add: [date: string, type: RecordType]; edit: [record: LocalRecord] }>()

const label = computed(() => {
  const [year, month, day] = props.date.split('-').map(Number)
  return `${month}月${day}日 · 周${'日一二三四五六'[new Date(year, month - 1, day).getDay()]}`
})

const sorted = computed(() =>
  [...props.records].sort((left, right) => left.startTime.localeCompare(right.startTime))
)

const dayTotal = computed(() =>
  sorted.value.reduce((sum, record) => sum + record.baseMinutes + record.overtimeMinutes, 0)
)

function endLabel(record: WorkRecord): string {
  const end = endTime(record.startTime, record.baseMinutes, record.overtimeMinutes)
  return `${end.nextDay ? '次日 ' : ''}${end.time}`
}
async function removeFromList(record: LocalRecord): Promise<void> {
  if (deleting.value) return
  if (!window.confirm('删除这条工时记录？\n删除后将更新本月统计。')) return
  deleting.value = record.id
  error.value = ''
  try {
    await props.onDelete(record)
  } catch {
    error.value = '删除未完成，请重试或重新打开当天记录确认。'
  } finally {
    deleting.value = null
  }
}
</script>

<template>
  <div class="sheet-overlay" @click.self="emit('close')">
    <section class="sheet detail-sheet" role="dialog" aria-modal="true" :aria-label="label">
      <div class="sheet-scroll">
        <div class="sheet-handle"></div>
        <div class="sheet-heading">
          <h2>{{ label }}</h2>
          <button class="icon-button" type="button" aria-label="关闭" @click="emit('close')"><X :size="22" /></button>
        </div>

        <template v-if="sorted.length">
          <div class="day-total">当日合计 {{ formatHours(dayTotal) }}</div>
          <div
            v-for="record in sorted"
            :key="record.id"
            class="record-card"
            :class="record.recordType === 'overtime' ? 'overtime' : record.location"
          >
            <button class="record-edit" type="button" :disabled="deleting !== null" @click="emit('edit', record)">
            <div class="record-top">
              <strong>{{ record.recordType === 'overtime' ? record.workContent : record.location ? LOCATION_LABEL[record.location] : '' }}</strong>
              <strong>{{ formatHours(record.baseMinutes + record.overtimeMinutes) }}</strong>
            </div>
            <div class="record-time">{{ record.startTime }} - {{ endLabel(record) }}</div>
            <div class="record-sub">
              <template v-if="record.recordType === 'overtime'">独立加班</template>
              <template v-else>基础 {{ formatHours(record.baseMinutes) }}<span v-if="record.overtimeMinutes"> · 加班 {{ formatHours(record.overtimeMinutes) }}</span></template>
            </div>
            </button>
            <button
              class="record-delete"
              type="button"
              :disabled="deleting !== null"
              :aria-label="`删除${record.recordType === 'overtime' ? record.workContent : record.location ? LOCATION_LABEL[record.location] : ''} ${record.startTime}的记录`"
              @click="removeFromList(record)"
            >
              <Trash2 :size="17" />
              <span>{{ deleting === record.id ? '删除中' : '删除' }}</span>
            </button>
          </div>
        </template>
        <p v-else class="empty-day">当天暂无工作记录</p>

        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <div class="record-actions detail-actions">
          <button class="primary-button" type="button" @click="emit('add', date, 'duty')"><Plus :size="18" /> 值班记录</button>
          <button class="primary-button overtime-button" type="button" @click="emit('add', date, 'overtime')"><Plus :size="18" /> 加班记录</button>
        </div>
      </div>
    </section>
  </div>
</template>
