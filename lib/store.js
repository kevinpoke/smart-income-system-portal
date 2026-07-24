"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  MODULES_META,
  HOURS_BETWEEN_MODULES,
  HOURS_UNTIL_AUTO_APPROVE_BUTTON,
  MONTHS_UNTIL_PAYOUT,
  rngFromSeed,
  randomFloat,
} from "./mockData";

const HOUR_MS = 60 * 60 * 1000;
const MONTH_MS = 30.44 * 24 * HOUR_MS;

function nowISO() {
  return new Date().toISOString();
}

function makeDefaultUser(overrides = {}) {
  const joinDate = nowISO();
  const rand = rngFromSeed(Math.floor(Date.now() / 1000) % 1e6);
  return {
    id: "user-1",
    name: "Alex Rivera",
    email: "alex.rivera@example.com",
    joinDate,
    // 'new' -> 'isp_pending' -> 'isp_approved_awaiting_start' -> 'active'
    status: "new",
    dailyRate: randomFloat(rand, 80, 150),
    ispApplication: null, // { provider, street, city, state, zip, ssid, password, submittedAt }
    ispSubmittedAt: null,
    approveButtonAvailableAt: null,
    manualApproveButtonSent: false,
    participationApprovedAt: null, // uptime timer start
    modules: {
      // moduleId -> { unlockedAt, viewedAt }
      1: { unlockedAt: joinDate, viewedAt: null },
    },
    withdrawal: {
      bank: null, // { routingNumber, accountNumber, fullName, address }
      testWithdrawalStatus: "none", // none | requested | complete
      testWithdrawalRequestedAt: null,
      testWithdrawalCompletedAt: null,
    },
    lastLogin: nowISO(),
    upsellsPurchased: 0,
    lastSupportContact: null,
    chat: {
      messages: [],
      tags: [],
    },
    ...overrides,
  };
}

const DEFAULT_TAG_OPTIONS = [
  "Refund",
  "Stalling",
  "Withdrawal Info",
  "Shutdown",
  "Upsell",
];

function makeDemoUsers() {
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const hoursAgo = (n) => new Date(Date.now() - n * 3600000).toISOString();

  const rand1 = rngFromSeed(101);
  const rand2 = rngFromSeed(202);
  const rand3 = rngFromSeed(303);

  return {
    "user-1": makeDefaultUser(),
    "user-2": makeDefaultUser({
      id: "user-2",
      name: "Priya Natarajan",
      email: "priya.n@example.com",
      joinDate: daysAgo(45),
      status: "active",
      dailyRate: randomFloat(rand1, 80, 150),
      ispApplication: {
        provider: "Xfinity",
        street: "88 Harbor Ln",
        city: "Tampa",
        state: "FL",
        zip: "33602",
        ssid: "PriyaNet_5G",
        password: "hunter2fl",
      },
      ispSubmittedAt: daysAgo(46),
      approveButtonAvailableAt: daysAgo(43),
      manualApproveButtonSent: false,
      participationApprovedAt: daysAgo(43),
      modules: {
        1: { unlockedAt: daysAgo(45), viewedAt: daysAgo(44) },
        2: { unlockedAt: daysAgo(44), viewedAt: daysAgo(43) },
        3: { unlockedAt: daysAgo(43), viewedAt: null },
      },
      upsellsPurchased: 1,
      lastSupportContact: hoursAgo(5),
      chat: {
        messages: [
          { id: "m1", sender: "user", text: "When will my next payout land?", at: hoursAgo(5) },
          {
            id: "m2",
            sender: "system",
            text: "Your message has been received. An agent will respond shortly.",
            at: hoursAgo(5),
          },
        ],
        tags: ["Withdrawal Info"],
      },
    }),
    "user-3": makeDefaultUser({
      id: "user-3",
      name: "Marcus Webb",
      email: "marcus.webb@example.com",
      joinDate: daysAgo(10),
      status: "isp_pending",
      dailyRate: randomFloat(rand2, 80, 150),
      ispApplication: {
        provider: "Spectrum",
        street: "220 Oak Ridge Dr",
        city: "Denver",
        state: "CO",
        zip: "80202",
        ssid: "WebbHouse",
        password: "denverwifi99",
      },
      ispSubmittedAt: hoursAgo(58),
      approveButtonAvailableAt: hoursAgo(-2),
      manualApproveButtonSent: false,
      chat: {
        messages: [
          {
            id: "m1",
            sender: "user",
            text: "This is taking forever, can you speed it up?",
            at: hoursAgo(20),
          },
          {
            id: "m2",
            sender: "system",
            text: "Your message has been received. An agent will respond shortly.",
            at: hoursAgo(20),
          },
        ],
        tags: ["Stalling"],
      },
      lastSupportContact: hoursAgo(20),
    }),
    "user-4": makeDefaultUser({
      id: "user-4",
      name: "Dana Kowalski",
      email: "dana.k@example.com",
      joinDate: daysAgo(120),
      status: "active",
      dailyRate: randomFloat(rand3, 80, 150),
      ispApplication: {
        provider: "Verizon",
        street: "5 Lakeview Ct",
        city: "Nashville",
        state: "TN",
        zip: "37203",
        ssid: "DanaK_WiFi",
        password: "musiccity2024",
      },
      ispSubmittedAt: daysAgo(121),
      approveButtonAvailableAt: daysAgo(118),
      participationApprovedAt: daysAgo(118),
      modules: {
        1: { unlockedAt: daysAgo(120), viewedAt: daysAgo(119) },
        2: { unlockedAt: daysAgo(119), viewedAt: daysAgo(118) },
        3: { unlockedAt: daysAgo(118), viewedAt: daysAgo(117) },
        4: { unlockedAt: daysAgo(117), viewedAt: daysAgo(116) },
        5: { unlockedAt: daysAgo(116), viewedAt: daysAgo(115) },
      },
      withdrawal: {
        bank: {
          routingNumber: "111000025",
          accountNumber: "000998877",
          fullName: "Dana Kowalski",
          address: "5 Lakeview Ct, Nashville, TN",
        },
        testWithdrawalStatus: "complete",
        testWithdrawalRequestedAt: daysAgo(100),
        testWithdrawalCompletedAt: daysAgo(99),
      },
      upsellsPurchased: 2,
      lastSupportContact: daysAgo(3),
      chat: {
        messages: [
          { id: "m1", sender: "user", text: "Can I upgrade to a Super Node?", at: daysAgo(3) },
          {
            id: "m2",
            sender: "admin",
            text: "Absolutely — I can get you set up with a Super Node today. Want me to send the link?",
            at: daysAgo(3),
          },
        ],
        tags: ["Upsell"],
      },
    }),
  };
}

export const useStore = create(
  persist(
    (set, get) => ({
      users: makeDemoUsers(),
      currentUserId: "user-1",
      tagOptions: DEFAULT_TAG_OPTIONS,

      // ---------- selectors/helpers ----------
      getCurrentUser: () => get().users[get().currentUserId],

      // ---------- ISP setup flow ----------
      submitIspApplication: (application) =>
        set((state) => {
          const uid = state.currentUserId;
          const user = state.users[uid];
          const submittedAt = nowISO();
          const approveAt = new Date(
            Date.now() + HOURS_UNTIL_AUTO_APPROVE_BUTTON * HOUR_MS
          ).toISOString();
          return {
            users: {
              ...state.users,
              [uid]: {
                ...user,
                ispApplication: application,
                ispSubmittedAt: submittedAt,
                status: "isp_pending",
                approveButtonAvailableAt: approveAt,
              },
            },
          };
        }),

      // Admin (or auto-timer) makes the Approve Participation button appear early
      manualSendApproveButton: (userId) =>
        set((state) => {
          const user = state.users[userId];
          if (!user) return {};
          return {
            users: {
              ...state.users,
              [userId]: {
                ...user,
                manualApproveButtonSent: true,
                approveButtonAvailableAt: nowISO(),
              },
            },
          };
        }),

      // User clicks "Approve Participation" -> starts uptime + earnings
      approveParticipation: (userId) =>
        set((state) => {
          const uid = userId || state.currentUserId;
          const user = state.users[uid];
          if (!user) return {};
          const approvedAt = nowISO();
          return {
            users: {
              ...state.users,
              [uid]: {
                ...user,
                status: "active",
                participationApprovedAt: approvedAt,
                modules: {
                  ...user.modules,
                  1: user.modules[1]?.unlockedAt
                    ? user.modules[1]
                    : { unlockedAt: approvedAt, viewedAt: null },
                },
              },
            },
          };
        }),

      adminApproveIsp: (userId) =>
        set((state) => {
          const user = state.users[userId];
          if (!user) return {};
          return {
            users: {
              ...state.users,
              [userId]: {
                ...user,
                manualApproveButtonSent: true,
                approveButtonAvailableAt: nowISO(),
              },
            },
          };
        }),

      adminRejectIsp: (userId) =>
        set((state) => {
          const user = state.users[userId];
          if (!user) return {};
          return {
            users: {
              ...state.users,
              [userId]: {
                ...user,
                status: "new",
                ispApplication: null,
                ispSubmittedAt: null,
                approveButtonAvailableAt: null,
              },
            },
          };
        }),

      // ---------- Modules ----------
      viewModule: (moduleId) =>
        set((state) => {
          const uid = state.currentUserId;
          const user = state.users[uid];
          const mod = user.modules[moduleId];
          if (!mod || mod.viewedAt) return {};
          const viewedAt = nowISO();
          const nextId = moduleId + 1;
          const nextUnlockAt = new Date(
            Date.now() + HOURS_BETWEEN_MODULES * HOUR_MS
          ).toISOString();
          const updatedModules = {
            ...user.modules,
            [moduleId]: { ...mod, viewedAt },
          };
          if (nextId <= MODULES_META.length && !updatedModules[nextId]) {
            updatedModules[nextId] = { unlockedAt: nextUnlockAt, viewedAt: null };
          }
          return {
            users: {
              ...state.users,
              [uid]: { ...user, modules: updatedModules },
            },
          };
        }),

      adminUnlockModule: (userId, moduleId) =>
        set((state) => {
          const user = state.users[userId];
          if (!user) return {};
          const nowIso = nowISO();
          return {
            users: {
              ...state.users,
              [userId]: {
                ...user,
                modules: {
                  ...user.modules,
                  [moduleId]: {
                    unlockedAt: nowIso,
                    viewedAt: user.modules[moduleId]?.viewedAt ?? null,
                  },
                },
              },
            },
          };
        }),

      // ---------- Withdrawals ----------
      saveBankInfo: (bank) =>
        set((state) => {
          const uid = state.currentUserId;
          const user = state.users[uid];
          return {
            users: {
              ...state.users,
              [uid]: {
                ...user,
                withdrawal: { ...user.withdrawal, bank },
              },
            },
          };
        }),

      requestTestWithdrawal: () =>
        set((state) => {
          const uid = state.currentUserId;
          const user = state.users[uid];
          return {
            users: {
              ...state.users,
              [uid]: {
                ...user,
                withdrawal: {
                  ...user.withdrawal,
                  testWithdrawalStatus: "requested",
                  testWithdrawalRequestedAt: nowISO(),
                },
              },
            },
          };
        }),

      adminCompleteTestWithdrawal: (userId) =>
        set((state) => {
          const user = state.users[userId];
          if (!user) return {};
          return {
            users: {
              ...state.users,
              [userId]: {
                ...user,
                withdrawal: {
                  ...user.withdrawal,
                  testWithdrawalStatus: "complete",
                  testWithdrawalCompletedAt: nowISO(),
                },
              },
            },
          };
        }),

      // ---------- Chat / Support ----------
      sendChatMessage: (text, sender = "user") =>
        set((state) => {
          const uid = state.currentUserId;
          const user = state.users[uid];
          const msg = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            sender,
            text,
            at: nowISO(),
          };
          const messages = [...user.chat.messages, msg];
          const withAutoReply =
            sender === "user"
              ? [
                  ...messages,
                  {
                    id: `${Date.now()}-auto`,
                    sender: "system",
                    text: "Your message has been received. An agent will respond shortly.",
                    at: nowISO(),
                  },
                ]
              : messages;
          return {
            users: {
              ...state.users,
              [uid]: {
                ...user,
                chat: { ...user.chat, messages: withAutoReply },
                lastSupportContact: nowISO(),
              },
            },
          };
        }),

      adminSendChatMessage: (userId, text) =>
        set((state) => {
          const user = state.users[userId];
          if (!user) return {};
          const msg = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            sender: "admin",
            text,
            at: nowISO(),
          };
          return {
            users: {
              ...state.users,
              [userId]: {
                ...user,
                chat: { ...user.chat, messages: [...user.chat.messages, msg] },
              },
            },
          };
        }),

      toggleUserTag: (userId, tag) =>
        set((state) => {
          const user = state.users[userId];
          if (!user) return {};
          const tags = user.chat.tags.includes(tag)
            ? user.chat.tags.filter((t) => t !== tag)
            : [...user.chat.tags, tag];
          return {
            users: {
              ...state.users,
              [userId]: { ...user, chat: { ...user.chat, tags } },
            },
          };
        }),

      addTagOption: (tag) =>
        set((state) =>
          state.tagOptions.includes(tag)
            ? {}
            : { tagOptions: [...state.tagOptions, tag] }
        ),

      removeTagOption: (tag) =>
        set((state) => ({
          tagOptions: state.tagOptions.filter((t) => t !== tag),
        })),

      // ---------- Admin: user management ----------
      recordUpsellPurchase: (userId) =>
        set((state) => {
          const user = state.users[userId];
          if (!user) return {};
          return {
            users: {
              ...state.users,
              [userId]: {
                ...user,
                upsellsPurchased: (user.upsellsPurchased || 0) + 1,
              },
            },
          };
        }),

      resetDemo: () =>
        set(() => ({
          users: makeDemoUsers(),
          currentUserId: "user-1",
        })),
    }),
    {
      name: "star-atlas-portal-store",
    }
  )
);

export { MONTHS_UNTIL_PAYOUT, MONTH_MS, HOUR_MS };
