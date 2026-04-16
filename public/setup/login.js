function nextTarget() {
  const params = new URLSearchParams(window.location.search)
  const next = params.get("next")
  return next && next.startsWith("/") ? next : "/"
}

function redirectToLogin() {
  const next = encodeURIComponent(`${window.location.pathname}${window.location.search}`)
  window.location.href = `/login?next=${next}`
}

async function fetchAuthConfig() {
  const res = await fetch("/setup/auth/config")
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

async function login(payload) {
  const res = await fetch("/setup/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

function setStatus(message) {
  document.getElementById("login-status").textContent = message
}

function renderFields(config) {
  const brand = config.brand || "SecureAI"
  document.getElementById("login-brand").textContent = brand
  document.getElementById("login-submit").textContent = config.submitLabel || "Continue"

  const fields = document.getElementById("login-fields")
  if (config.mode === "guest") {
    document.getElementById("login-title").textContent = config.guestTitle || brand
    document.getElementById("login-lede").textContent = config.guestLede || "Private workspace access for your internal AI tools."
    document.getElementById("login-card-title").textContent = config.cardTitle || "What should we call you?"
    document.getElementById("login-mode-label").textContent = "Name access"
    document.getElementById("login-card-lede").textContent = config.cardLede || "Enter your name to continue."
    fields.innerHTML = `
      <label>
        <span>${config.guestLabel || "Name"}</span>
        <input name="name" autocomplete="name" placeholder="Enter your name" required>
      </label>`
    setStatus("Enter your name to continue.")
    return
  }

  document.getElementById("login-title").textContent = config.title || "Enter the agent workspace."
  document.getElementById("login-lede").textContent = config.lede || "Use the branded entry screen to reach your business agent console."
  document.getElementById("login-card-title").textContent = config.cardTitle || "Sign in"
  document.getElementById("login-mode-label").textContent = "Credentials"
  document.getElementById("login-card-lede").textContent = config.cardLede || "Sign in with your workspace credentials."
  fields.innerHTML = `
    <label>
      <span>Username</span>
      <input name="username" autocomplete="username" required>
    </label>
    <label>
      <span>Password</span>
      <input name="password" type="password" autocomplete="current-password" required>
    </label>`
  setStatus("Sign in to continue.")
}

window.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("login-form")
  fetchAuthConfig()
    .then(config => {
      renderFields(config)
      form.addEventListener("submit", async event => {
        event.preventDefault()
        setStatus("Signing in…")
        try {
          if (config.mode === "guest") {
            await login({ name: form.elements.name.value.trim(), next: nextTarget() })
          } else {
            await login({
              username: form.elements.username.value.trim(),
              password: form.elements.password.value,
              next: nextTarget(),
            })
          }
          window.location.href = nextTarget()
        } catch (err) {
          if (err.message === "Unauthorized") {
            redirectToLogin()
            return
          }
          setStatus(err.message === "invalid_credentials" ? "Incorrect username or password." : `Sign-in failed: ${err.message}`)
        }
      })
    })
    .catch(err => {
      setStatus(`Could not load sign-in options: ${err.message}`)
    })
})
