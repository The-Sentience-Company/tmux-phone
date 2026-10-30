// The push carries no data: it says a new "for you" file landed, so ask the server which one.
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let item;
    try { item = (await (await fetch("/api/for-you")).json()).items.find((i) => !i.seen); } catch {}
    // iOS drops the subscription if a push shows no notification, so one is always shown.
    await self.registration.showNotification(item ? item.name : "New file for you", {
      body: item ? "for you" : "", data: { path: item?.path }, tag: item?.path || "for-you",
    });
  })());
});

// Tapping it opens the app on that file: an open window gets a message, else a new one opens at /#for-you=<path>.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data?.path;
  event.waitUntil((async () => {
    const [win] = await clients.matchAll({ type: "window", includeUncontrolled: true });
    if (win) {
      await win.focus();
      if (path) win.postMessage({ forYou: path });
      return;
    }
    await clients.openWindow(path ? `/#for-you=${encodeURIComponent(path)}` : "/");
  })());
});
