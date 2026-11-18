/* NEXO Suite — Firebase Cloud Messaging Background Service Worker */
importScripts('https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js');
importScripts('https://www.gstatic.com/firebasejs/8.10.1/firebase-messaging.js');

firebase.initializeApp({
  apiKey: "AIzaSyCMlEqyv5J0dsyWAs3iQEbb8N2BO9u9Krs",
  authDomain: "nexo-pay-a5e86.firebaseapp.com",
  databaseURL: "https://nexo-pay-a5e86-default-rtdb.firebaseio.com",
  projectId: "nexo-pay-a5e86",
  storageBucket: "nexo-pay-a5e86.firebasestorage.app",
  messagingSenderId: "870398931159",
  appId: "1:870398931159:web:5836ba4539d4f650e14092"
});

const messaging = firebase.messaging();

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

messaging.setBackgroundMessageHandler(function (payload) {
  const data = (payload && payload.data) || {};
  const notif = (payload && payload.notification) || {};
  const title = data.title || notif.title || 'NEXO Alert';
  const body = data.body || notif.body || 'You have a new NEXO update.';
  const targetApp = data.app || 'pay';
  const icon = data.icon || `/icons/pwa-${targetApp}-192x192.png`;
  const targetUrl = data.url || `/${targetApp}`;

  return self.registration.showNotification(title, {
    body,
    icon,
    badge: `/icons/pwa-${targetApp}-192x192.png`,
    vibrate: [220, 100, 220],
    timestamp: Date.now(),
    tag: data.tag || `nexo-${targetApp}-${Date.now()}`,
    renotify: true,
    actions: [{ action: 'open', title: 'View Details' }],
    data: { url: targetUrl }
  });
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/pay';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
  
