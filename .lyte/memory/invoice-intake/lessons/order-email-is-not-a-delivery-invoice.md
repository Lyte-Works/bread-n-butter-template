---
description: A vendor "order submitted" email or confirmation is being logged as if goods arrived
triggers: order confirmation, Online Order Submitted, order email, invoice status, delivery check-in, received, partial delivery
rule: Record an order confirmation with `invoice_status` Ordered, never Received, because it proves only what was requested, not what arrived or was billed.
tags: [invoices, status]
touches: [workers/skills/invoice-intake/SKILL.md]
worker: invoice-intake
---
A US Foods "Online Order Submitted" email is an ORDER. Statuses on Invoices: Ordered / Received / Partial / Disputed. There is no line-level record of what arrived; delivery check-in is an open thread, not something to fake with the status field.
