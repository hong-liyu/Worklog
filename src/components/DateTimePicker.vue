<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { ChevronLeft, ChevronRight, X } from '@lucide/vue'
import { localDate, monthCells } from '../domain'

const props = defineProps<{ kind: 'date' | 'time'; value: string; title: string }>()
const emit = defineEmits<{ confirm: [value: string]; close: [] }>()
const dialog = ref<HTMLDialogElement>()
const draft = ref(props.value)
const [initialYear, initialMonth] = (props.kind === 'date' ? props.value : localDate(new Date())).split('-').map(Number)
const year = ref(initialYear)
const month = ref(initialMonth)
const cells = computed(() => monthCells(year.value, month.value))
const hour = ref(props.kind === 'time' ? props.value.slice(0, 2) : '00')
const minute = ref(props.kind === 'time' ? props.value.slice(3) : '00')
// Keep an exact historical/derived minute available without expanding all 60 choices.
const minutes = [...new Set(['00', '15', '30', '45', minute.value])].sort()
const pad = (value: number) => String(value).padStart(2, '0')
const today = localDate(new Date())

onMounted(async () => {
  dialog.value?.showModal()
  await nextTick()
  dialog.value?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()
})

function shiftMonth(delta: number): void {
  const date = new Date(year.value, month.value - 1 + delta, 1)
  year.value = date.getFullYear()
  month.value = date.getMonth() + 1
}

function goToday(): void {
  draft.value = today
  const [y, m] = today.split('-').map(Number)
  year.value = y
  month.value = m
}

function gridKey(event: KeyboardEvent, columns: number): void {
  const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key]
  if (offset === undefined) return
  const buttons = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button')]
  const index = buttons.indexOf(event.target as HTMLButtonElement)
  if (index < 0) return
  event.preventDefault()
  buttons[(index + offset + buttons.length) % buttons.length]?.focus()
}

function confirm(): void {
  emit('confirm', props.kind === 'date' ? draft.value : `${hour.value}:${minute.value}`)
}
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="picker-dialog" :aria-label="title" @cancel.prevent="emit('close')" @click="event => { if (event.target === dialog) emit('close') }">
      <div class="picker-content">
        <div class="sheet-heading">
          <h2>{{ title }}</h2>
          <button type="button" class="icon-button" aria-label="关闭选择面板" @click="emit('close')"><X :size="22" /></button>
        </div>
        <template v-if="kind === 'date'">
          <div class="picker-month-nav">
            <button type="button" class="icon-button" aria-label="上个月" @click="shiftMonth(-1)"><ChevronLeft :size="22" /></button>
            <strong aria-live="polite">{{ year }}年{{ month }}月</strong>
            <button type="button" class="icon-button" aria-label="下个月" @click="shiftMonth(1)"><ChevronRight :size="22" /></button>
          </div>
          <div class="weekdays" aria-hidden="true"><span v-for="day in ['一','二','三','四','五','六','日']" :key="day">{{ day }}</span></div>
          <div class="picker-date-grid" @keydown="gridKey($event, 7)">
            <template v-for="(date, index) in cells" :key="date ?? index">
              <button v-if="date" type="button" class="picker-choice" :class="{ 'is-today': date === today }" :aria-label="date" :aria-current="date === today ? 'date' : undefined" :aria-pressed="draft === date" @click="draft = date">{{ Number(date.slice(-2)) }}</button>
              <span v-else></span>
            </template>
          </div>
          <button type="button" class="picker-today" @click="goToday">今天</button>
        </template>
        <template v-else>
          <div class="picker-preview" aria-live="polite">{{ hour }}<span>:</span>{{ minute }}</div>
          <div class="field-label">小时</div>
          <div class="picker-hour-grid" @keydown="gridKey($event, 6)">
            <button v-for="value in 24" :key="value" class="picker-choice" type="button" :aria-label="`${pad(value - 1)}时`" :aria-pressed="hour === pad(value - 1)" @click="hour = pad(value - 1)">{{ pad(value - 1) }}</button>
          </div>
          <div class="field-label">分钟</div>
          <div class="picker-minute-grid" @keydown="gridKey($event, minutes.length)">
            <button v-for="value in minutes" :key="value" class="picker-choice" type="button" :aria-label="`${value}分`" :aria-pressed="minute === value" @click="minute = value">{{ value }}</button>
          </div>
        </template>
        <div class="picker-actions">
          <button class="secondary-button" type="button" @click="emit('close')">取消</button>
          <button class="primary-button" type="button" @click="confirm">确定</button>
        </div>
      </div>
    </dialog>
  </Teleport>
</template>
