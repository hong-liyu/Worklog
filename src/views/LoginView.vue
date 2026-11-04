<script setup lang="ts">
import { ref } from 'vue'
import { login, readError } from '../api'
import { setMeta } from '../storage'

const emit = defineEmits<{ success: [] }>()
const username = ref('admin')
const password = ref('')
const busy = ref(false)
const error = ref('')
const offline = ref(false)

async function submit(): Promise<void> {
  if (busy.value) return
  if (!username.value.trim() || !password.value) {
    error.value = '请填写用户名和密码'
    return
  }
  busy.value = true
  error.value = ''
  offline.value = false
  try {
    const response = await login(username.value.trim(), password.value)
    if (response.ok) {
      await setMeta('lastLoginAt', new Date().toISOString())
      await setMeta('username', username.value.trim())
      emit('success')
      return
    }
    error.value = await readError(response)
  } catch {
    offline.value = true
    error.value = '无法连接服务器，请检查网络后重试'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="login-page">
    <form class="login-card" @submit.prevent="submit">
      <div class="login-mark">工</div>
      <h1>工时记录</h1>
      <p>密码只在本机参与派生，服务器只会收到不可逆的口令凭据。</p>

      <label for="login-user">用户名</label>
      <input id="login-user" v-model="username" class="field" autocomplete="username" autocapitalize="none" required />

      <label for="login-pass">密码</label>
      <input id="login-pass" v-model="password" class="field" type="password" autocomplete="current-password" required />

      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <p v-if="offline" class="login-hint">首次使用需要联网登录，之后断网也能打开已登录的设备。</p>

      <button class="primary-button" type="submit" :disabled="busy">{{ busy ? '正在验证…' : '登录' }}</button>
    </form>
  </div>
</template>
