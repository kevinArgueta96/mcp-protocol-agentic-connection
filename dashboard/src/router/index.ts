import { createRouter, createWebHashHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    name: "dashboard",
    component: () => import("@/views/DashboardView.vue"),
  },
  {
    path: "/agents/:id",
    name: "agent-detail",
    component: () => import("@/views/AgentDetailView.vue"),
    props: true,
  },
  {
    path: "/channels",
    name: "channels",
    component: () => import("@/views/ConversationsView.vue"),
  },
  {
    path: "/:pathMatch(.*)*",
    redirect: "/",
  },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
