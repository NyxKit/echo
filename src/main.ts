import { createApp } from 'vue'
import 'nyx-kit/style.css'
import './styles.scss'
import { RouterView } from 'vue-router'
import { router } from './router'
import { vClickOutside } from 'nyx-kit/directives'

// Supply kit defaults without resetting its persisted colour-mode preference.
const app = createApp(RouterView).provide('libEnv', {}).directive('click-outside', vClickOutside).use(router)
void router.isReady().then(() => app.mount('#app'))
