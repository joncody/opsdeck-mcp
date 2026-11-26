import { expect, test } from "@playwright/test";

test("renders modern streamable-http status, live Postgres state, and MCP runbooks", async function testOpsState({
  page,
}) {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "OpsDeck MCP" })).toBeVisible();
  await expect(page.getByText("server-ops (modern · streamable-http)")).toBeVisible();
  await expect(page.getByText("checkout-api").first()).toBeVisible();
  await expect(page.getByText("auth-gateway").first()).toBeVisible();

  await page.getByRole("button", { name: /Production Deployment Rollback Procedure/i }).click();
  await expect(page.getByText("# Production Deployment Rollback Procedure")).toBeVisible();
});

test("streams triage tool loop and records JSON-RPC wire frames and trace spans", async function testTriage({
  page,
}) {
  await page.goto("/");

  await page.getByRole("button", { name: "Triage", exact: true }).click();
  await expect(page.getByText("server-ops__list_incidents").first()).toBeVisible();
  await expect(page.getByText("server-ops__get_service_detail").first()).toBeVisible();
  await expect(page.getByText("Grounded MCP investigation complete.").first()).toBeVisible();

  await page.getByRole("button", { name: /MCP Wire & Traces/i }).click();
  await expect(page.getByText("tools/call").first()).toBeVisible();
  await expect(page.getByText("llm.turn:mock").first()).toBeVisible();
});

test("supports cooperative async task cancellation and completion", async function testTasks({
  page,
}) {
  await page.goto("/");

  await page.getByRole("button", { name: "Probe (Task)" }).click();
  const cancelBtn = page.getByRole("button", { name: "Cancel Task" });
  await expect(cancelBtn).toBeVisible();
  await cancelBtn.click();
  await expect(page.getByText("CANCELLED").first()).toBeVisible();

  await page.getByRole("button", { name: "Probe (Task)" }).click();
  await expect(page.getByText("COMPLETED").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("activePgConnections").first()).toBeVisible();
});

test("renders dynamic elicitation form from InputRequiredResult and handles decline", async function testElicit({
  page,
}) {
  await page.goto("/");
  await expect(page.getByText("auth-gateway").first()).toBeVisible();

  const needsReset = (await page.getByText("v2.14.3").count()) === 0;
  test.skip(needsReset, "checkout-api already rolled back; restore v2.14.3 or run `pnpm db:reset`");

  await page.getByRole("button", { name: "Rollback (Elicit)" }).click();
  await expect(page.getByText(/Human Confirmation Required \(rollback_deployment\)/i)).toBeVisible();
  await expect(page.getByText(/requestState: rs1\./i)).toBeVisible();

  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByText("Decision submitted: decline")).toBeVisible();
  await expect(page.getByText("cancelled_by_operator")).toBeVisible();
});
