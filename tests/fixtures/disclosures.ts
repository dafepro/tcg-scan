import { expect, type Page } from "@playwright/test";

/** Use the visible progressive-disclosure control; never force hidden inputs. */
export async function openDisclosure(page: Page, label: string) {
  const summary = page.locator("summary").filter({ hasText: label });
  await expect(summary).toHaveCount(1);
  await expect(summary).toBeVisible();
  if ((await summary.locator("..").getAttribute("open")) === null)
    await summary.click();
  await expect(summary.locator("..")).toHaveAttribute("open", "");
}

/** Explicitly accept a requested session boundary through its visible dialog. */
export async function confirmSessionSwitch(page: Page) {
  const dialog = page.getByRole("dialog", {
    name: "End this scanning session and switch?",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Saved cards stay in your collection");
  await dialog
    .getByRole("button", { name: "End session and switch", exact: true })
    .click();
  await expect(dialog).toBeHidden();
}

/** Ready databases live inside Scan options; setup for a fresh profile stays primary. */
export async function openReadyPackManager(page: Page) {
  await openDisclosure(page, "Scan options");
  const toggle = page.getByRole("button", {
    name: /installed references · manage offline packs/,
  });
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#scanner-pack-manager")).toBeVisible();
  return toggle;
}
