<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ChevronDown, Trash2, X } from '@lucide/vue'
import {
  defaultStart,
  endTime,
  overtimeFromEnd,
  parseOvertime,
  validateInput,
  type RecordInput,
  type WorkLocation
} from '../domain'
import type { LocalRecord } from '../storage'

const props = defineProps<{
  date: string
  record?: LocalRecord
  lastLocation: WorkLocation
  onSave: (input: RecordInput, existing?: LocalRecord) => Promise<void>
  onDelete: (record: LocalRecord) => Promise<void>
  onClose: () => void
}>()

const start = props.record?.startTime ?? defaultStart(new Date())
const form = reactive({
  workDate: props.record?.workDate ?? props.date,
  location: props.record?.location ?? props.lastLocation,
  startTime: start,
  baseMinutes: (props.record?.baseMinutes ?? 120) as 120 | 180,
  overtime: props.record ? String(Number((props.record.overtimeMinutes / 60).toFixed(2))) : '0',
  endTime: endTime(start, props.record?.baseMinutes ?? 120, props.record?.overtimeMinutes ?? 0).time
})

const overtimeOpen = ref(Boolean(props.record?.overtimeMinutes))
const touched = ref(false)
const error = ref('')
const busy = ref(false)

const nextDay = computed(() => {
  try {
    return endTime(form.startTime, form.baseMinutes, parseOvertime(form.overtime)).nextDay
  } catch {
    return false
  }
})

const timezone =
  props.record?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Asia/Shanghai'

function recalculate(): void {
  touched.value = true
  try {
    form.endTime = endTime(form.startTime, form.baseMinutes, parseOvertime(form.overtime)).time
    error.value = ''
  } catch (err) {
    error.value = (err as Error).message
  }
}

function changeEnd(): void {
  touched.value = true
  try {
    const minutes = overtimeFromEnd(form.startTime, form.endTime, form.baseMinutes)
    if (minutes < 0) throw new Error('结束时间不能早于基础工时对应的结束时间')
    if (minutes > 720) throw new Error('加班时间不能超过 12 小时')
    form.overtime = String(Number((minutes / 60).toFixed(2)))
    if (minutes > 0) overtimeOpen.value = true
    error.value = ''
  } catch (err) {
    error.value = (err as Error).message
  }
}

function requestClose(): void {
  if (touched.value && !window.confirm('放弃未保存的修改？')) return
  props.onClose()
}

async function submit(): Promise<void> {
  if (busy.value) return
  try {
    if (error.value) throw new Error(error.value)
    const input: RecordInput = {
      workDate: form.workDate,
      location: form.location,
      startTime: form.startTime,
      baseMinutes: form.baseMinutes,
      overtimeMinutes: parseOvertime(form.overtime),
      timezone
    }
    validateInput(input)
    if (endTime(input.startTime, input.baseMinutes, input.overtimeMinutes).time !== form.endTime) {
      throw new Error('结束时间与工时不一致')
    }
    busy.value = true
    await props.onSave(input, props.record)
  } catch (err) {
    error.value = (err as Error).message
    busy.value = false
  }
}

async function remove(): Promise<void> {
  if (!props.record || busy.value) return
  if (!window.confirm('删除这条工时记录？\n删除后将更新本月统计。')) return
  busy.value = true
  try {
    await props.onDelete(props.record)
  } catch (err) {
    error.value = (err as Error).message
    busy.value = false
  }
}

let touchY = 0
function onTouchStart(event: TouchEvent): void {
  touchY = event.touches[0]?.clientY ?? 0
}
function onTouchEnd(event: TouchEvent): void {
  if ((event.changedTouches[0]?.clientY ?? 0) - touchY > 80) requestClose()
}
</script>

<template>
  <div class="sheet-overlay" @click.self="requestClose">
    <section class="sheet" role="dialog" aria-modal="true" :aria-label="record ? '编辑记录' : '记录工时'">
      <div class="sheet-scroll">
        <div class="sheet-handle" @touchstart="onTouchStart" @touchend="onTouchEnd"></div>
        <div class="sheet-heading">
          <h2>{{ record ? '编辑记录' : '记录工时' }}</h2>
          <button class="icon-button" type="button" aria-label="关闭" @click="requestClose"><X :size="22" /></button>
        </div>

        <label class="field-label" for="work-date">日期</label>
        <input id="work-date" v-model="form.workDate" class="field" type="date" @change="touched = true" />

        <div class="field-label">工作地点</div>
        <div class="segments">
          <button
            v-for="item in ([['art_center', '艺术中心'], ['sutuo', '素拓']] as const)"
            :key="item[0]"
            type="button"
            :class="{ active: form.location === item[0] }"
            @click="form.location = item[0]; touched = true"
          >
            {{ item[1] }}
          </button>
        </div>

        <div class="field-label">工作时间</div>
        <div class="time-row">
          <label>
            开始
            <input v-model="form.startTime" class="field" type="time" @change="recalculate" />
          </label>
          <span class="time-arrow">→</span>
          <label>
            结束<span v-if="nextDay" class="next-day">次日</span>
            <input v-model="form.endTime" class="field" type="time" @change="changeEnd" />
          </label>
        </div>

        <div class="field-label">基础工时</div>
        <div class="segments">
          <button
            v-for="minutes in ([120, 180] as const)"
            :key="minutes"
            type="button"
            :class="{ active: form.baseMinutes === minutes }"
            @click="form.baseMinutes = minutes; recalculate()"
          >
            {{ minutes / 60 }} 小时
          </button>
        </div>

        <div class="overtime-section">
          <button class="overtime-toggle" type="button" :aria-expanded="overtimeOpen" @click="overtimeOpen = !overtimeOpen">
            <span><ChevronDown :size="18" :class="{ rotated: !overtimeOpen }" /> 加班时间</span>
            <span>{{ parseFloat(form.overtime) > 0 ? `${form.overtime}h` : '未添加' }}</span>
          </button>
          <div v-if="overtimeOpen" class="overtime-input">
            <input
              v-model="form.overtime"
              class="field"
              type="text"
              inputmode="decimal"
              placeholder="0"
              @input="recalculate"
            />
            <span>小时</span>
          </div>
        </div>

        <p v-if="error" class="form-error" role="alert">{{ error }}</p>

        <div class="sheet-actions">
          <button class="primary-button" type="button" :disabled="busy" @click="submit">
            {{ busy ? '正在保存…' : record ? '保存修改' : '保存记录' }}
          </button>
          <button v-if="record" class="delete-button" type="button" :disabled="busy" @click="remove">
            <Trash2 :size="18" /> 删除记录
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
