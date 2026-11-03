<script setup lang="ts">
import { computed } from 'vue'
import { dayColor, monthCells, type WorkRecord } from '../domain'

const props = defineProps<{ year: number; month: number; records: WorkRecord[]; today: string }>()
const emit = defineEmits<{ select: [date: string] }>()
const cells = computed(() => monthCells(props.year, props.month))
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
</script>

<template>
  <section class="calendar" aria-label="月份日历">
    <div class="weekdays"><span v-for="day in weekdays" :key="day">{{ day }}</span></div>
    <div class="calendar-grid">
      <template v-for="(date, index) in cells" :key="date ?? `blank-${index}`">
        <button v-if="date" class="day-cell" :class="[dayColor(records, date), { today: date === today }]" type="button" :aria-label="`${date}，查看记录`" @click="emit('select', date)">{{ Number(date.slice(-2)) }}</button>
        <span v-else class="day-cell blank" aria-hidden="true"></span>
      </template>
    </div>
  </section>
</template>
