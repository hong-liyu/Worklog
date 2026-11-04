<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue'
import { ChevronDown, Trash2, X } from '@lucide/vue'
import {
  defaultStart,
  endTime,
  overtimeFromEnd,
  parseOvertime,
  validateInput,
  type RecordInput,
  type RecordType,
  type WorkLocation
} from '../domain'
import DateTimePicker from './DateTimePicker.vue'
import type { LocalRecord } from '../storage'

const props = defineProps<{
  date: string
  recordType: RecordType
  record?: LocalRecord
  lastLocation: WorkLocation
  onSave: (input: RecordInput, existing?: LocalRecord) => Promise<void>
  onDelete: (record: LocalRecord) => Promise<void>
  onClose: () => void
}>()

const standalone = props.recordType === 'overtime'
const title = props.record ? (standalone ? '编辑加班记录' : '编辑值班记录') : (standalone ? '加班记录' : '值班记录')
const start = props.record?.startTime ?? defaultStart(new Date())
const form = reactive({
  workDate: props.record?.workDate ?? props.date,
  location: props.record?.location ?? props.lastLocation,
  workContent: props.record?.workContent ?? '',
  startTime: start,
  baseMinutes: (props.record?.baseMinutes ?? (standalone ? 0 : 120)) as 0 | 120 | 180,
  overtime: props.record ? String(Number((props.record.overtimeMinutes / 60).toFixed(2))) : (standalone ? '1' : '0'),
  endTime: endTime(start, props.record?.baseMinutes ?? (standalone ? 0 : 120), props.record?.overtimeMinutes ?? (standalone ? 60 : 0)).time
})

const overtimeMinutes = ref(props.record?.overtimeMinutes ?? (standalone ? 60 : 0))
const picker = ref<'workDate' | 'startTime' | 'endTime' | null>(null)
let pickerTrigger: HTMLElement | null = null
function openPicker(field: 'workDate' | 'startTime' | 'endTime', event: MouseEvent): void {
  pickerTrigger = event.currentTarget as HTMLElement
  picker.value = field
}
async function closePicker(): Promise<void> {
  picker.value = null
  await nextTick()
  pickerTrigger?.focus()
}
function confirmPicker(value: string): void {
  const field = picker.value
  if (!field) return
  form[field] = value
  touched.value = true
  if (field === 'endTime') changeEnd()
  else if (field === 'startTime') recalculate()
  void closePicker()
}

const overtimeOpen = ref(Boolean(props.record?.overtimeMinutes))
const touched = ref(false)
const error = ref('')
const busy = ref(false)

const nextDay = computed(() => {
  try {
    return endTime(form.startTime, form.baseMinutes, overtimeMinutes.value).nextDay
  } catch {
    return false
  }
})

const timezone =
  props.record?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Asia/Shanghai'

function changeDuration(): void {
  touched.value = true
  try {
    const minutes = parseOvertime(form.overtime)
    if (standalone && minutes < 1) throw new Error('加班时长至少1分钟')
    overtimeMinutes.value = minutes
    recalculate()
  } catch (err) {
    error.value = (err as Error).message
  }
}

function recalculate(): void {
  touched.value = true
  try {
    const parsed = parseOvertime(form.overtime)
    if (standalone && parsed < 1) throw new Error('加班时长至少1分钟')
    form.endTime = endTime(form.startTime, form.baseMinutes, overtimeMinutes.value).time
    error.value = ''
  } catch (err) {
    error.value = (err as Error).message
  }
}

function changeEnd(): void {
  touched.value = true
  try {
    const minutes = overtimeFromEnd(form.startTime, form.endTime, form.baseMinutes)
    if (standalone && minutes < 1) throw new Error('加班时长至少1分钟')
    if (minutes < 0) throw new Error('结束时间不能早于基础工时对应的结束时间')
    if (minutes > 720) throw new Error('加班时间不能超过 12 小时')
    overtimeMinutes.value = minutes
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
    if (parseOvertime(form.overtime) !== overtimeMinutes.value) throw new Error('请检查加班时长')
    const input: RecordInput = {
      workDate: form.workDate,
      recordType: props.recordType,
      workContent: standalone ? form.workContent.trim() : null,
      location: standalone ? null : form.location,
      startTime: form.startTime,
      baseMinutes: form.baseMinutes,
      overtimeMinutes: overtimeMinutes.value,
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
    <section class="sheet" role="dialog" aria-modal="true" :aria-label="title" :inert="picker !== null" :aria-hidden="picker !== null ? true : undefined">
      <div class="sheet-scroll">
        <div class="sheet-handle" @touchstart="onTouchStart" @touchend="onTouchEnd"></div>
        <div class="sheet-heading">
          <h2>{{ title }}</h2>
          <button class="icon-button" type="button" aria-label="关闭" @click="requestClose"><X :size="22" /></button>
        </div>

        <label class="field-label" for="work-date">日期</label>
        <button id="work-date" class="field picker-trigger" type="button" aria-haspopup="dialog" @click="openPicker('workDate', $event)">{{ form.workDate.replaceAll('-', ' / ') }}</button>

        <template v-if="standalone">
          <label class="field-label" for="work-content">工作内容</label>
          <textarea id="work-content" v-model="form.workContent" class="field work-content" rows="2" maxlength="200" placeholder="例如：整理资料、布置场地" @input="touched = true"></textarea>
          <div class="field-hint">{{ Array.from(form.workContent.trim()).length }} / 100 字</div>
        </template>
        <template v-else>
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

        </template>

        <div class="field-label">工作时间</div>
        <div class="time-row">
          <label>
            开始
            <button class="field picker-trigger" type="button" aria-label="选择开始时间" aria-haspopup="dialog" @click="openPicker('startTime', $event)">{{ form.startTime }}</button>
          </label>
          <span class="time-arrow">→</span>
          <label>
            结束<span v-if="nextDay" class="next-day">次日</span>
            <button class="field picker-trigger" type="button" aria-label="选择结束时间" aria-haspopup="dialog" @click="openPicker('endTime', $event)">{{ form.endTime }}</button>
          </label>
        </div>

        <template v-if="!standalone">
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

        </template>

        <div class="overtime-section" :class="{ 'standalone-duration': standalone }">
          <label v-if="standalone" class="field-label" for="standalone-hours">加班时长</label>
          <button v-else class="overtime-toggle" type="button" :aria-expanded="overtimeOpen" @click="overtimeOpen = !overtimeOpen">
            <span><ChevronDown :size="18" :class="{ rotated: !overtimeOpen }" /> 加班时间</span>
            <span>{{ parseFloat(form.overtime) > 0 ? `${form.overtime}h` : '未添加' }}</span>
          </button>
          <div v-if="standalone || overtimeOpen" class="overtime-input">
            <input
              :id="standalone ? 'standalone-hours' : 'duty-overtime'"
              :aria-label="standalone ? '加班时长（小时）' : '附加加班时长（小时）'"
              v-model="form.overtime"
              class="field"
              type="text"
              inputmode="decimal"
              placeholder="0"
              @input="changeDuration"
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
    <DateTimePicker v-if="picker" :key="picker" :kind="picker === 'workDate' ? 'date' : 'time'" :value="form[picker]" :title="picker === 'workDate' ? '选择日期' : picker === 'startTime' ? '开始时间' : '结束时间'" @confirm="confirmPicker" @close="closePicker" />
  </div>
</template>
