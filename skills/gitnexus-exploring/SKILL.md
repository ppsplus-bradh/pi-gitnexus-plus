---
name: gitnexus-exploring
description: "Use when the user asks how code works, wants to understand architecture, trace execution flows, or explore unfamiliar parts of the codebase. Examples: \"How does X work?\", \"What calls this function?\", \"Show me the auth flow\""
---

# Exploring Codebases with GitNexus

## When to Use

- "How does authentication work?"
- "What's the project structure?"
- "Show me the main components"
- "Where is the database logic?"
- Understanding code you haven't seen before

## Workflow

```
1. gitnexus_list_repos()                                   → Discover indexed repos
2. gitnexus_read_resource({uri: "gitnexus://repo/{name}/context"}) → Repo overview + stats
3. gitnexus_query({query: "<what you want to understand>"}) → Find related execution flows
4. gitnexus_context({name: "<symbol>"})                     → Deep dive on specific symbol
5. Read source files for implementation details
```

> If index is stale → run `/gitnexus analyze` to rebuild.

## Checklist

```
- [ ] gitnexus_list_repos to discover indexed repos
- [ ] gitnexus_read_resource for repo overview, clusters, or schema
- [ ] gitnexus_query for the concept you want to understand
- [ ] Review returned processes (execution flows)
- [ ] gitnexus_context on key symbols for callers/callees
- [ ] gitnexus_route_map or gitnexus_tool_map for API/tool structure
- [ ] Read source files for implementation details
```

## Tools

**gitnexus_query** — find execution flows related to a concept:

```
gitnexus_query({query: "payment processing"})
→ Processes: CheckoutFlow, RefundFlow, WebhookHandler
→ Symbols grouped by flow with file locations
```

**gitnexus_context** — 360-degree view of a symbol:

```
gitnexus_context({name: "validateUser"})
→ Incoming calls: loginHandler, apiMiddleware
→ Outgoing calls: checkToken, getUserById
→ Processes: LoginFlow (step 2/5), TokenRefresh (step 1/3)
```

**gitnexus_cypher** — custom graph queries for deeper exploration:

```
gitnexus_cypher({query: "MATCH (f:Function)-[:CodeRelation {type: 'CALLS'}]->(g) WHERE f.name = 'main' RETURN g.name, g.filePath"})
```

**gitnexus_read_resource** — read repo context, module details, or graph schema:

```
gitnexus_read_resource({uri: "gitnexus://repo/my-app/clusters"})
→ All functional areas (Leiden clusters) in the repo

gitnexus_read_resource({uri: "gitnexus://repo/my-app/processes"})
→ All execution flows in the repo
```

**gitnexus_route_map** — understand API structure:

```
gitnexus_route_map({})
→ All API routes, their handlers, middleware, and consumers
```

## Example: "How does payment processing work?"

```
1. gitnexus_query({query: "payment processing"})
   → CheckoutFlow: processPayment → validateCard → chargeStripe
   → RefundFlow: initiateRefund → calculateRefund → processRefund

2. gitnexus_context({name: "processPayment"})
   → Incoming: checkoutHandler, webhookHandler
   → Outgoing: validateCard, chargeStripe, saveTransaction

3. Read src/payments/processor.ts for implementation details
```
