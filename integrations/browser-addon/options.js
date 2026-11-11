const api = typeof browser !== "undefined" ? browser : chrome

async function requestServerPermission(serverUrl) {
  try {
    const origin = new URL(serverUrl).origin + "/*"
    const granted = await api.permissions.request({ origins: [origin] })
    return granted
  } catch (error) {
    // Permissions may only be requested from a user gesture; the save click
    // counts, but URL parsing failures land here.
    return false
  }
}

document.getElementById("save").addEventListener("click", async () => {
  const serverUrl = document.getElementById("serverUrl").value.trim().replace(/\/+$/, "")
  const pushToken = document.getElementById("pushToken").value.trim()
  if (!serverUrl) return

  await api.storage.local.set({ serverUrl, pushToken })
  const granted = await requestServerPermission(serverUrl)
  const saved = document.getElementById("saved")
  saved.hidden = false
  saved.textContent = granted ? "Saved ✓" : "Saved ✓ (server permission not granted yet)"
  setTimeout(() => {
    saved.hidden = true
  }, 2500)
})

api.storage.local.get(["serverUrl", "pushToken"]).then((stored) => {
  document.getElementById("serverUrl").value = stored.serverUrl || ""
  document.getElementById("pushToken").value = stored.pushToken || ""
})
