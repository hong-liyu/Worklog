<script setup lang="ts">
import { computed } from 'vue'
import { Plus, X } from '@lucide/vue'
import { endTime, formatHours, LOCATION_LABEL, type RecordType, type WorkRecord } from '../domain'
import type { LocalRecord } from '../storage'

const props = defineProps<{ date: string; records: LocalRecord[] }>()
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
          <button
            v-for="record in sorted"
            :key="record.id"
            type="button"
            class="record-card"
            :class="record.recordType === 'overtime' ? 'overtime' : record.location"
            @click="emit('edit', record)"
          >
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
        </template>
        <p v-else class="empty-day">当天暂无工作记录</p>

        <div class="record-actions detail-actions">
          <button class="primary-button" type="button" @click="emit('add', date, 'duty')"><Plus :size="18" /> 值班记录</button>
          <button class="primary-button overtime-button" type="button" @click="emit('add', date, 'overtime')"><Plus :size="18" /> 加班记录</button>
        </div>
      </div>
    </section>
  </div>
</template>
