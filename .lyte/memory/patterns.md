# Restaurant Patterns

<!-- Every role reads this at boot. Write here when the owner states a preference or decision that applies to every role, not just one. Each line dated once it is the restaurant's own. -->

## Human Preferences
- Prefers plain kitchen words — dish, prep, ingredient, case, vendor, food cost; never software terms
- Show the working — every cost traceable to the invoice line it came from
- Accuracy over speed — say "I don't know yet" rather than guess a number
- The owner approves — new ingredients, conversions, price changes and anything published

## Kitchen Decisions
- Cost basis is what was actually paid, per base unit (oz, fl oz, each) — see the invoice-intake lessons
- A dish over 30% food cost, or up 2+ points since the day before the latest delivery, is flagged (`cost_alerts`)
