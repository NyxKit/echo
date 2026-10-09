import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: App },
    { path: '/import', name: 'import', component: App },
    { path: '/settings', name: 'settings', component: App },
    { path: '/conversation/:id([a-f0-9]{64})', name: 'conversation', component: App },
    { path: '/:pathMatch(.*)*', redirect: { name: 'home' } },
  ],
})
