import { expect, test } from "@playwright/test";

test("edits a todo list", async ({ page }) => {
  await page.setContent(`
    <main>
      <h1>Todos</h1>
      <form>
        <input aria-label="New todo" placeholder="What needs doing?">
        <button>Add</button>
      </form>
      <ul><li>Inspect the packed trace</li></ul>
      <script>
        const form = document.querySelector('form')
        const input = document.querySelector('input')
        const list = document.querySelector('ul')
        form.addEventListener('submit', event => {
          event.preventDefault()
          const item = document.createElement('li')
          item.textContent = input.value
          list.append(item)
          input.value = ''
        })
      </script>
    </main>
  `);

  await page.getByLabel("New todo").fill("Share one HTML file");
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("listitem")).toHaveText([
    "Inspect the packed trace",
    "Share one HTML file",
  ]);
});

test("captures network and console activity", async ({ page }) => {
  await page.route("https://example.test/api/profile", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ name: "Trace Viewer", status: "ready" }),
    }),
  );
  await page.route("https://example.test/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `
      <main>
        <h1>Profile</h1>
        <output>Loading…</output>
        <script>
          console.info('Loading profile')
          fetch('/api/profile')
            .then(response => response.json())
            .then(profile => {
              document.querySelector('output').textContent = profile.name + ': ' + profile.status
              console.info('Profile loaded', profile)
            })
        </script>
      </main>
    `,
    }),
  );

  await page.goto("https://example.test/");
  await expect(page.getByText("Trace Viewer: ready")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("profile.png") });
});
