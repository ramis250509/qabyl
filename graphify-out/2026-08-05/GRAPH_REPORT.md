# Graph Report - qabyl  (2026-08-05)

## Corpus Check
- 297 files · ~257,576 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1630 nodes · 2961 edges · 178 communities (103 shown, 75 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 38 edges (avg confidence: 0.66)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1e8076be`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- admin/calendar.tsx
- dependencies
- routeTree.gen.ts
- wa-agent.server.ts
- WA Agent Architecture Plan (Lovable plan.md)
- Graphify Full Pipeline Skill
- wa-agent-v4.server.ts
- devDependencies
- sidebar.tsx
- ops-agents.server.ts
- carousel.tsx
- ig.$salonId.ts
- wa-agent.scenarios.test.ts
- admin.tsx
- $salonId.tsx
- utils.ts
- compilerOptions
- components.json
- client.ts
- sections.tsx
- normalizeIndustry
- cn
- ServiceExportDialog.tsx
- PublicBooking.tsx
- wa-v4-booking.test.ts
- runWaAgentV3
- AiAssistantTab.tsx
- Что необходимо проверить
- notifications.tsx
- wa.$salonId.ts
- Architecture
- InstagramTab.tsx
- WaSimulator.tsx
- menubar.tsx
- SalonSite.tsx
- dialog.tsx
- plan.md
- buildSystemPromptV4
- server.ts
- industries.ts
- wa-industries.server.ts
- Changes Made
- wa-agent-v4.scenarios.test.ts
- FileRoutesByPath
- frankfurt-migrate.ts
- AI-admin test matrix — 2026-07-30
- Findings
- Qabyl App Icon (512px)
- service-catalog-templates.ts
- Qabyl App Icon (192px PWA)
- context-menu.tsx
- Qabyl Brand Identity
- sw.js
- dropdown-menu.tsx
- Graphify Explain (plain-language node explanation)
- Graphify Path (shortest path between concepts)
- __root.tsx
- types.ts
- Deployment report — 2026-07-30
- formatPrice
- /graphify
- What You Must Do When Invoked
- graphify reference: extra exports and benchmark
- wa-agent-v3.scenarios.test.ts
- graphify reference: query, path, explain
- table.tsx
- Extraction Subagent Prompt Spec
- Step 3 - Extract entities and relationships
- graphify reference: add a URL and watch a folder
- graphify reference: commit hook and native CLAUDE.md integration
- BFS Graph Traversal (Query Mode)
- graphify reference: incremental update and cluster-only
- graphify reference: GitHub clone and cross-repo merge
- graphify reference: transcribe video and audio
- Routes
- .claude/CLAUDE.md
- Graphify Skill Reference (Claude CLAUDE.md)
- i18n.tsx
- Neo4j Export (--neo4j flag)
- extraction-spec.md
- GitHub Clone Flow (graphify clone)
- manage.$token.tsx
- Qabyl technical + security audit — 2026-07-30
- frankfurt-fn-secrets.ts
- MasterDayOverrides.tsx
- book.$slug.tsx
- breadcrumb.tsx
- drawer.tsx
- navigation-menu.tsx
- account.functions.ts
- send-push/index.ts
- toggle-group.tsx
- client.server.ts
- error-log.server.ts
- branch-masters.functions.ts
- salon-masters.functions.ts
- send-whatsapp/index.ts
- auth-middleware.ts
- salon-admins.functions.ts
- Vertical readiness — 2026-07-30
- alert.tsx
- input-otp.tsx
- wa-check.functions.ts
- router.tsx
- audit-regressions.test.ts
- accordion.tsx
- avatar.tsx
- example.functions.ts
- site-content.functions.ts
- sitemap[.]xml.ts
- test-supabase.mjs
- scroll-area.tsx
- privacy.tsx
- @ai-sdk/openai-compatible
- clsx
- cmdk
- date-fns
- @dnd-kit/core
- @dnd-kit/sortable
- @dnd-kit/utilities
- embla-carousel-react
- @hookform/resolvers
- input-otp
- isomorphic-dompurify
- lucide-react
- @radix-ui/react-alert-dialog
- @radix-ui/react-aspect-ratio
- @radix-ui/react-avatar
- @radix-ui/react-checkbox
- @radix-ui/react-collapsible
- @radix-ui/react-dialog
- @radix-ui/react-dropdown-menu
- @radix-ui/react-hover-card
- @radix-ui/react-label
- @radix-ui/react-menubar
- @radix-ui/react-navigation-menu
- @radix-ui/react-popover
- @radix-ui/react-progress
- @radix-ui/react-radio-group
- @radix-ui/react-scroll-area
- @radix-ui/react-select
- @radix-ui/react-separator
- @radix-ui/react-slider
- @radix-ui/react-slot
- @radix-ui/react-switch
- @radix-ui/react-tabs
- @radix-ui/react-toggle
- @radix-ui/react-toggle-group
- @radix-ui/react-tooltip
- react-day-picker
- react-dom
- react-hook-form
- react-resizable-panels
- recharts
- sonner
- @supabase/supabase-js
- tailwind-merge
- tailwindcss
- @tailwindcss/vite
- @tanstack/react-query
- @tanstack/react-router
- @tanstack/react-start
- @tanstack/router-plugin
- vaul
- vite-tsconfig-paths
- zod
- frankfurt-check.ts
- frankfurt-dedup-roles.ts
- frankfurt-rest-probe.ts
- cleanup-wa-media/index.ts
- send-reminders/index.ts

## God Nodes (most connected - your core abstractions)
1. `cn()` - 72 edges
2. `runWaAgentV3()` - 40 edges
3. `supabase` - 31 edges
4. `Button` - 27 edges
5. `Card` - 24 edges
6. `useAuth()` - 24 edges
7. `FileRoutesByPath` - 24 edges
8. `Graphify Full Pipeline Skill` - 24 edges
9. `executeV4Tool()` - 22 edges
10. `Input` - 21 edges

## Surprising Connections (you probably didn't know these)
- `WA State Machine Design` --rationale_for--> `WhatsApp AI Assistant (wa-agent.server.ts)`  [INFERRED]
  .lovable/plan.md → CLAUDE.md
- `create_appointment RPC (extended with _price_override)` --shares_data_with--> `Supabase (Auth + Postgres + Storage)`  [INFERRED]
  .lovable/plan.md → CLAUDE.md
- `CalendarDayButton()` --references--> `react`  [EXTRACTED]
  src/components/ui/calendar.tsx → package.json
- `useCarousel()` --references--> `react`  [EXTRACTED]
  src/components/ui/carousel.tsx → package.json
- `useChart()` --references--> `react`  [EXTRACTED]
  src/components/ui/chart.tsx → package.json

## Import Cycles
- 3-file cycle: `src/components/site/SalonSite.tsx -> src/components/site/templates/MinimalTemplate.tsx -> src/components/site/sections.tsx -> src/components/site/SalonSite.tsx`
- 3-file cycle: `src/components/site/SalonSite.tsx -> src/components/site/templates/PremiumTemplate.tsx -> src/components/site/sections.tsx -> src/components/site/SalonSite.tsx`
- 3-file cycle: `src/components/site/SalonSite.tsx -> src/components/site/templates/VividTemplate.tsx -> src/components/site/sections.tsx -> src/components/site/SalonSite.tsx`

## Hyperedges (group relationships)
- **WA Agent Core Architecture (state machine + lock + Gemini classifier)** — lovable_plan_state_machine, lovable_plan_advisory_lock, lovable_plan_gemini_intent_classifier [EXTRACTED 0.95]
- **Graphify Extraction Pipeline (AST + semantic + merge)** — claude_skills_graphify_skill_ast_extraction, claude_skills_graphify_skill_semantic_extraction, claude_skills_graphify_skill_extraction_cache [EXTRACTED 1.00]
- **WA Agent NLP Improvements (fuzzy + intent + yes/no detection)** — wa_agent_improvements_fuzzy_matching, wa_agent_improvements_intent_promotion, wa_agent_improvements_yes_no_detection, wa_agent_improvements_master_name_matching [EXTRACTED 1.00]

## Communities (178 total, 75 thin omitted)

### Community 0 - "admin/calendar.tsx"
Cohesion: 0.07
Nodes (54): CreateAppointmentDialog(), DateQuickPicker(), FreeSlotPicker(), Master, MoveAppointmentDialog(), Service, TIME_OPTIONS, BranchFilterBar() (+46 more)

### Community 1 - "dependencies"
Cohesion: 0.13
Nodes (15): ai, class-variance-authority, dompurify, dependencies, ai, class-variance-authority, dompurify, qrcode.react (+7 more)

### Community 2 - "routeTree.gen.ts"
Cohesion: 0.06
Nodes (30): AdminAccountRoute, AdminCalendarRoute, AdminErrorsRoute, AdminIndexRoute, AdminNotificationsRoute, AdminOpsRoute, AdminRoute, AdminRouteChildren (+22 more)

### Community 3 - "wa-agent.server.ts"
Cohesion: 0.07
Nodes (47): AdminClient, appBaseUrl(), availablePartsToday(), callGemini(), clampLanguage(), classify(), classifyManageIntentV3(), compose() (+39 more)

### Community 4 - "WA Agent Architecture Plan (Lovable plan.md)"
Cohesion: 0.07
Nodes (35): createServerFn Pattern (server functions), Green-API (WhatsApp Integration), i18n Layer (ru/ky/en, useT() hook), Qabyl Project (Beauty Salon Booking Platform), routeTree.gen.ts (auto-generated, never edit), Supabase (Auth + Postgres + Storage), supabaseAdmin (service role, bypasses RLS), Supabase Client (RLS-respecting, browser) (+27 more)

### Community 5 - "Graphify Full Pipeline Skill"
Cohesion: 0.11
Nodes (20): Graphify Add URL (ingest), Graphify Watch Mode (auto-rebuild), MCP Server (--mcp flag), Wiki Export (--wiki flag), Post-Commit Auto-Rebuild Hook, Whisper Video/Audio Transcription, build_merge (incremental graph merge), Cluster-Only Rerun (--cluster-only flag) (+12 more)

### Community 6 - "wa-agent-v4.server.ts"
Cohesion: 0.08
Nodes (42): RFC-4122, callGeminiTools(), confidentLanguage(), createGeminiCache(), DbMaster, downloadImageAsBase64(), fetchMergedSlots(), GeminiV2Content (+34 more)

### Community 7 - "devDependencies"
Cohesion: 0.04
Nodes (46): eslint, eslint-config-prettier, @eslint/js, eslint-plugin-prettier, eslint-plugin-react-hooks, eslint-plugin-react-refresh, globals, @lovable.dev/vite-tanstack-config (+38 more)

### Community 8 - "sidebar.tsx"
Cohesion: 0.06
Nodes (37): Separator, SheetContent, SheetContentProps, SheetDescription, SheetFooter(), SheetHeader(), SheetOverlay, SheetTitle (+29 more)

### Community 9 - "ops-agents.server.ts"
Cohesion: 0.12
Nodes (34): agentsEnabled(), audit(), buildDailyDigest(), db(), DigestSnapshot, ErrorGroup, errorReport(), fetchDigestSnapshot() (+26 more)

### Community 10 - "carousel.tsx"
Cohesion: 0.05
Nodes (34): react, react, Carousel, CarouselApi, CarouselContent, CarouselContext, CarouselContextProps, CarouselItem (+26 more)

### Community 11 - "ig.$salonId.ts"
Cohesion: 0.12
Nodes (26): acquireConversationLock(), LOCK_HEARTBEAT_MS, LOCK_TTL_SECONDS, NOTE: the WhatsApp route (src/routes/api/public/wa.$salonId.ts) still carries…, refreshConversationLock(), releaseConversationLock(), stillHoldingConversationLock(), IgCreds (+18 more)

### Community 12 - "wa-agent.scenarios.test.ts"
Cohesion: 0.09
Nodes (22): bigMenuSalon(), BRANCHES, branchSalon(), composeSystemInstructions, CONFIG, confirmDraft(), convo(), convoV3() (+14 more)

### Community 13 - "admin.tsx"
Cohesion: 0.16
Nodes (24): PullToRefresh(), useNotifications(), signOutFromApp(), BUILD_VAPID_PUBLIC_KEY, debugLog(), disablePushSubscription(), EnsurePushOptions, ensurePushSubscription() (+16 more)

### Community 14 - "$salonId.tsx"
Cohesion: 0.11
Nodes (12): BranchHours, BranchHoursEditor(), defaultBranchHours(), invalidHourDays(), WEEKDAYS, Checkbox, BranchDialog(), SalonInfoTab() (+4 more)

### Community 15 - "utils.ts"
Cohesion: 0.09
Nodes (16): CardContent, CardDescription, CardFooter, CardHeader, CardTitle, FullScreenLoader(), LoadingState(), getSsrLanding (+8 more)

### Community 16 - "compilerOptions"
Cohesion: 0.07
Nodes (26): DOM, DOM.Iterable, ES2022, eslint.config.js, src/**/*.ts, src/**/*.tsx, vite/client, vite.config.ts (+18 more)

### Community 17 - "components.json"
Cohesion: 0.11
Nodes (18): aliases, components, hooks, lib, ui, utils, iconLibrary, registries (+10 more)

### Community 18 - "client.ts"
Cohesion: 0.18
Nodes (13): Override, ServiceRow, SalonShareCard(), Button, Card, DialogTitle, Input, AppNotification (+5 more)

### Community 19 - "sections.tsx"
Cohesion: 0.17
Nodes (14): DAYS_RU, NAV_LABEL_KEYS, SiteContacts(), SiteFaq(), SiteFooter(), SiteGallery(), SiteMasters(), SiteReviews() (+6 more)

### Community 20 - "normalizeIndustry"
Cohesion: 0.29
Nodes (7): DEFAULT_INDUSTRY, isIndustryKey(), normalizeIndustry(), colorForCategoryIndex(), INDUSTRY_EXPERT, IndustrySelectCard(), ServicesTab()

### Community 21 - "cn"
Cohesion: 0.13
Nodes (18): ButtonProps, buttonVariants, Calendar(), CalendarDayButton(), HoverCardContent, Pagination(), PaginationContent, PaginationEllipsis() (+10 more)

### Community 22 - "ServiceExportDialog.tsx"
Cohesion: 0.21
Nodes (19): Props, ServiceExportDialog(), useAutoPrintFromQuery(), TabsContent, TabsList, TabsTrigger, catalogAsText(), CatalogSalon (+11 more)

### Community 23 - "PublicBooking.tsx"
Cohesion: 0.12
Nodes (16): Branch, Faq, FaqSection(), formatDuration(), Master, PublicBooking(), Salon, Service (+8 more)

### Community 24 - "wa-v4-booking.test.ts"
Cohesion: 0.16
Nodes (6): DATE, input, makeDb(), makeDbWithMastersProbe(), slotISO(), slotRow()

### Community 25 - "runWaAgentV3"
Cohesion: 0.13
Nodes (22): backRow(), buildBranchListMsg(), buildCategoryListMsg(), buildConfirmMsg(), buildDateListMsg(), buildManageActionMsg(), buildManageChoiceMsg(), buildMasterListMsg() (+14 more)

### Community 26 - "AiAssistantTab.tsx"
Cohesion: 0.16
Nodes (13): AiAssistantTab(), Assistant, ExcludedContact, ReviewsTab(), SiteTab(), TEMPLATES, Label, labelVariants (+5 more)

### Community 27 - "Что необходимо проверить"
Cohesion: 0.11
Nodes (17): 1. Архитектуру, 2. Производительность, 3. Работа ИИ-Админа, 4. Работа Green API, 5. Работа базы данных, 6. Безопасность, 7. Пользовательский опыт, 8. Масштабируемость (+9 more)

### Community 28 - "notifications.tsx"
Cohesion: 0.21
Nodes (14): BulkRow, fmtDate(), Kind, SalonDayOverridesCard(), AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription (+6 more)

### Community 29 - "wa.$salonId.ts"
Cohesion: 0.09
Nodes (18): GreenApiCreds, greenApiDownloadFile(), greenApiSendFileByUrl(), greenApiSendMessage(), isLikelyNativeGreetingRace(), normalizeChatIdToPhone(), WaAgentState, WaAgentStateData (+10 more)

### Community 30 - "Architecture"
Cohesion: 0.13
Nodes (13): Architecture, Auth and roles, Commands, Environment variables, File-based routing (`src/routes/`), graphify, i18n, Project (+5 more)

### Community 31 - "InstagramTab.tsx"
Cohesion: 0.19
Nodes (12): diagnose(), Diagnostics, InstagramTab(), TestState, whenLabel(), getInstagramConfig, getInstagramDiagnostics, igWebhookUrl() (+4 more)

### Community 32 - "WaSimulator.tsx"
Cohesion: 0.15
Nodes (14): Conversation, Message, needsHuman(), statusBadge(), WaChatsTab(), ChatMessage, HistoryMsg, InteractiveMessage (+6 more)

### Community 33 - "menubar.tsx"
Cohesion: 0.12
Nodes (11): Menubar, MenubarCheckboxItem, MenubarContent, MenubarItem, MenubarLabel, MenubarRadioItem, MenubarSeparator, MenubarShortcut() (+3 more)

### Community 34 - "SalonSite.tsx"
Cohesion: 0.22
Nodes (12): BranchContactsBar(), Branch, BranchContactCard(), BranchesContactsBlock(), BranchVariant, VARIANT_STYLES, SalonSiteData, CustomTemplate() (+4 more)

### Community 35 - "dialog.tsx"
Cohesion: 0.13
Nodes (13): Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut() (+5 more)

### Community 36 - "plan.md"
Cohesion: 0.14
Nodes (13): 10. Технические детали реализации, 11. Файлы, которые меняются, 12. Проверка после имплементации, 13. Что НЕ делаем в этом плане, 1. Архитектурное замечание (важно), 2. Миграция БД (lock + state machine + цена), 3. Секрет, 4. Анти-гонка вебхуков (Green-API часто шлёт два webhook'а параллельно) (+5 more)

### Community 37 - "buildSystemPromptV4"
Cohesion: 0.15
Nodes (9): addDaysISO(), buildDateMap(), nowInTz(), ownerPhoneMatches(), parseDateFromTextV3(), buildSystemPromptV4(), renderKnowledgeAnswers(), renderPhotoNotes() (+1 more)

### Community 38 - "server.ts"
Cohesion: 0.24
Nodes (8): attachSupabaseAuth, consumeLastCapturedError(), renderErrorPage(), fetch(), getServerEntry(), normalizeCatastrophicSsrResponse(), ServerEntry, errorMiddleware

### Community 39 - "industries.ts"
Cohesion: 0.14
Nodes (13): barbershopQuestions, beautyQuestions, cosmetologyQuestions, dentalQuestions, epilationQuestions, INDUSTRY_PRICING, IndustryMeta, IndustryPricing (+5 more)

### Community 41 - "wa-industries.server.ts"
Cohesion: 0.22
Nodes (11): BEAUTY_KNOWLEDGE_BASE, DOCTOR_NOUN, IndustryExpert, MASTER_NOUN, SpecialistNoun, BARBERSHOP_KNOWLEDGE_BASE, COSMETOLOGY_KNOWLEDGE_BASE, DENTAL_KNOWLEDGE_BASE (+3 more)

### Community 42 - "Changes Made"
Cohesion: 0.14
Nodes (13): 1. **Enabled Gemini Thinking Budget** (Line 289), 2. **Increased Intent Classification Temperature** (Line 729), 3. **Improved Service Fuzzy Matching** (Line 438, 444), 4. **Better Master Name Matching** (Line 1269-1280), 5. **Smarter Intent Promotion Logic** (Line 621-632), 6. **Enhanced Yes/No Detection** (Line 508-516), 7. **More Tolerant Time/Part-of-Day Parsing** (Line 491-505), 8. **Slightly Higher Reply Temperature** (Line 819) (+5 more)

### Community 43 - "wa-agent-v4.scenarios.test.ts"
Cohesion: 0.22
Nodes (4): dbProxy, geminiQueue, geminiRequests, SALON

### Community 44 - "FileRoutesByPath"
Cohesion: 0.14
Nodes (13): Route, Route, Route, Route, Route, Route, Route, Route (+5 more)

### Community 45 - "frankfurt-migrate.ts"
Cohesion: 0.22
Nodes (12): adminOpts, buildPgUrl(), copyAuth(), loadCreds(), main(), MASTER_TABLES, oldDb, PgCfg (+4 more)

### Community 46 - "AI-admin test matrix — 2026-07-30"
Cohesion: 0.18
Nodes (10): AI-admin test matrix — 2026-07-30, Constant-time webhook token compare — 4 tests, Endocrinology / medical vertical — 4 tests, JSON-LD injection defense — 3 tests, New tests added in this audit, Per-industry scenario coverage summary, Prompt-injection defense — every industry × 1 test, Regressions from `main` (pre-existing — not addressed here) (+2 more)

### Community 47 - "Findings"
Cohesion: 0.18
Nodes (10): Coverage of the requested checklist, Findings, P2-1 (fixed) — JSON-LD injection on public salon page, P2-2 (fixed) — Timing-side-channel on WhatsApp webhook token, P2-3 (fixed) — No size cap on inbound WhatsApp images, P2-4 (fixed) — Public `checkPhoneWhatsapp` quota-drain vector, P3-1 (accepted with note) — DOMPurify on `CustomTemplate`, Security audit — 2026-07-30 (+2 more)

### Community 48 - "Qabyl App Icon (512px)"
Cohesion: 0.83
Nodes (4): Qabyl App Icon (512px), Qabyl Brand Identity, Teal-to-Pink Gradient Background, Stylized Q Logo Mark

### Community 49 - "service-catalog-templates.ts"
Cohesion: 0.18
Nodes (10): barbershop, beauty, CatalogService, CATEGORY_COLORS, cosmetology, dental, epilation, massage (+2 more)

### Community 50 - "Qabyl App Icon (192px PWA)"
Cohesion: 1.00
Nodes (3): Qabyl App Icon (192px PWA), Qabyl Brand Identity — Q lettermark with teal-to-pink gradient, Progressive Web App (PWA) Icon Asset 192x192

### Community 51 - "context-menu.tsx"
Cohesion: 0.20
Nodes (9): ContextMenuCheckboxItem, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuRadioItem, ContextMenuSeparator, ContextMenuShortcut(), ContextMenuSubContent (+1 more)

### Community 54 - "dropdown-menu.tsx"
Cohesion: 0.20
Nodes (9): DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut(), DropdownMenuSubContent (+1 more)

### Community 58 - "__root.tsx"
Cohesion: 0.22
Nodes (4): Toaster(), ToasterProps, Route, FileRoutesById

### Community 59 - "types.ts"
Cohesion: 0.20
Nodes (9): CompositeTypes, Constants, DatabaseWithoutInternals, DefaultSchema, Enums, Json, Tables, TablesInsert (+1 more)

### Community 61 - "Deployment report — 2026-07-30"
Cohesion: 0.22
Nodes (8): Commit list (this branch), Deployment report — 2026-07-30, Post-merge smoke test (owner runs after promoting), Preview URL, Quality gates, Rollback, Status, What still requires owner attention

### Community 62 - "formatPrice"
Cohesion: 0.28
Nodes (8): AiServiceListEditor(), ServiceCard(), fmt(), formatPrice(), formatPriceShort(), ServicePrice, MasterDialog(), ServiceRow()

### Community 63 - "/graphify"
Cohesion: 0.18
Nodes (10): For /graphify add and --watch, For /graphify query, For the commit hook and native CLAUDE.md integration, For --update and --cluster-only, /graphify, Interpreter guard for subcommands, PowerShell 5.1: Vertical scrolling stops working, Troubleshooting (+2 more)

### Community 64 - "What You Must Do When Invoked"
Cohesion: 0.18
Nodes (11): Step 0 - GitHub repos and multi-path merge (only if a URL or several paths), Step 1 - Ensure graphify is installed, Step 2.5 - Video and audio (only if video files detected), Step 2 - Detect files, Step 4.5 - Graph health check (read-only integrity gate), Step 4 - Build graph, cluster, analyze, generate outputs, Step 5 - Label communities, Step 6 - Generate Obsidian vault (opt-in) + HTML (+3 more)

### Community 65 - "graphify reference: extra exports and benchmark"
Cohesion: 0.22
Nodes (8): graphify reference: extra exports and benchmark, Step 6b - Wiki (only if --wiki flag), Step 7 - Neo4j export (only if --neo4j or --neo4j-push flag), Step 7a - FalkorDB export (only if --falkordb or --falkordb-push flag), Step 7b - SVG export (only if --svg flag), Step 7c - GraphML export (only if --graphml flag), Step 7d - MCP server (only if --mcp flag), Step 8 - Token reduction benchmark (only if total_words > 5000)

### Community 66 - "wa-agent-v3.scenarios.test.ts"
Cohesion: 0.25
Nodes (5): CONFIG, dbProxy, SALON, SERVICE, visionQueue

### Community 67 - "graphify reference: query, path, explain"
Cohesion: 0.33
Nodes (5): For /graphify explain, For /graphify path, graphify reference: query, path, explain, Step 0 — Constrained query expansion (REQUIRED before traversal), Step 1 — Traversal

### Community 68 - "table.tsx"
Cohesion: 0.22
Nodes (8): Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow

### Community 69 - "Extraction Subagent Prompt Spec"
Cohesion: 0.50
Nodes (4): Confidence Score Rubric (EXTRACTED/INFERRED/AMBIGUOUS), Node ID Format Rules, Extraction Subagent Prompt Spec, Honesty Rules

### Community 70 - "Step 3 - Extract entities and relationships"
Cohesion: 0.50
Nodes (4): Part A - Structural extraction for code files, Part B - Semantic extraction (parallel subagents), Part C - Merge AST + semantic into final extraction, Step 3 - Extract entities and relationships

### Community 71 - "graphify reference: add a URL and watch a folder"
Cohesion: 0.50
Nodes (3): For /graphify add, For --watch, graphify reference: add a URL and watch a folder

### Community 72 - "graphify reference: commit hook and native CLAUDE.md integration"
Cohesion: 0.50
Nodes (3): For git commit hook, For native CLAUDE.md integration, graphify reference: commit hook and native CLAUDE.md integration

### Community 73 - "BFS Graph Traversal (Query Mode)"
Cohesion: 0.50
Nodes (4): BFS Graph Traversal (Query Mode), DFS Graph Traversal (Query Mode), Save-Result Feedback Loop (self-improving), Query Vocab Expansion (constrained token matching)

### Community 74 - "graphify reference: incremental update and cluster-only"
Cohesion: 0.50
Nodes (3): For --cluster-only, For --update (incremental re-extraction), graphify reference: incremental update and cluster-only

### Community 80 - "i18n.tsx"
Cohesion: 0.25
Nodes (8): Ctx, DictKey, Entry, I18nContext, I18nProvider(), Lang, LANGS, LanguageSwitcher()

### Community 84 - "manage.$token.tsx"
Cohesion: 0.22
Nodes (3): Route, Slot, Snapshot

### Community 85 - "Qabyl technical + security audit — 2026-07-30"
Cohesion: 0.25
Nodes (7): Baseline tests, Cross-references, Files touched, Not deployed to production, Qabyl technical + security audit — 2026-07-30, Scoring — before → after, What still requires the owner's attention

### Community 86 - "frankfurt-fn-secrets.ts"
Cohesion: 0.25
Nodes (6): lines, missing, sql, vapidPriv, vapidPub, vapidSub

### Community 87 - "MasterDayOverrides.tsx"
Cohesion: 0.36
Nodes (6): Kind, kindLabel(), MasterDayOverrides(), Override, RadioGroup, RadioGroupItem

### Community 88 - "book.$slug.tsx"
Cohesion: 0.25
Nodes (3): SalonSite(), Route, Route

### Community 89 - "breadcrumb.tsx"
Cohesion: 0.25
Nodes (7): Breadcrumb, BreadcrumbEllipsis(), BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator()

### Community 90 - "drawer.tsx"
Cohesion: 0.25
Nodes (6): DrawerContent, DrawerDescription, DrawerFooter(), DrawerHeader(), DrawerOverlay, DrawerTitle

### Community 91 - "navigation-menu.tsx"
Cohesion: 0.25
Nodes (7): NavigationMenu, NavigationMenuContent, NavigationMenuIndicator, NavigationMenuList, NavigationMenuTrigger, navigationMenuTriggerStyle, NavigationMenuViewport

### Community 92 - "account.functions.ts"
Cohesion: 0.36
Nodes (7): anonClient(), emailFromClaims(), resolveCurrentEmail(), updateMyLogin, updateMyPassword, verifyPassword(), AccountPage()

### Community 93 - "send-push/index.ts"
Cohesion: 0.29
Nodes (7): b64urlDecode(), cors, isValidVapidPublic(), supabase, VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY, VAPID_SUBJECT

### Community 94 - "toggle-group.tsx"
Cohesion: 0.33
Nodes (5): ToggleGroup, ToggleGroupContext, ToggleGroupItem, Toggle, toggleVariants

### Community 95 - "client.server.ts"
Cohesion: 0.29
Nodes (5): Database, assertCanManageSalon(), notifyClientReschedule(), getAdmin(), getAdmin()

### Community 96 - "error-log.server.ts"
Cohesion: 0.38
Nodes (6): supabaseAdmin, ErrorSource, fingerprintOf(), logError(), LogErrorInput, stackOf()

### Community 97 - "branch-masters.functions.ts"
Cohesion: 0.29
Nodes (5): assertCanManageBranch(), createBranchMaster, listBranchMasters, revokeBranchMaster, WORDS

### Community 98 - "salon-masters.functions.ts"
Cohesion: 0.29
Nodes (5): assertCanManageSalon(), createSalonMaster, listSalonMasters, revokeSalonMaster, WORDS

### Community 99 - "send-whatsapp/index.ts"
Cohesion: 0.33
Nodes (3): corsHeaders, readGreenApiBody(), sendGreenApi()

### Community 100 - "auth-middleware.ts"
Cohesion: 0.40
Nodes (3): requireSupabaseAuth, getSalonSecrets, upsertSalonSecrets

### Community 101 - "salon-admins.functions.ts"
Cohesion: 0.33
Nodes (3): createSalonAdmin, listSalonAdmins, revokeSalonAdmin

### Community 102 - "Vertical readiness — 2026-07-30"
Cohesion: 0.33
Nodes (5): Acceptance criteria explicitly verified, Per-vertical scores, Rating rubric, Vertical readiness — 2026-07-30, What each vertical is missing (nothing critical)

### Community 103 - "alert.tsx"
Cohesion: 0.40
Nodes (4): Alert, AlertDescription, AlertTitle, alertVariants

### Community 104 - "input-otp.tsx"
Cohesion: 0.40
Nodes (4): InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot

### Community 105 - "wa-check.functions.ts"
Cohesion: 0.40
Nodes (3): cache, rlSeen, WaCheckStatus

### Community 106 - "router.tsx"
Cohesion: 0.40
Nodes (4): getRouter(), Register, routeTree, startInstance

### Community 108 - "accordion.tsx"
Cohesion: 0.50
Nodes (3): AccordionContent, AccordionItem, AccordionTrigger

### Community 109 - "avatar.tsx"
Cohesion: 0.50
Nodes (3): Avatar, AvatarFallback, AvatarImage

### Community 111 - "site-content.functions.ts"
Cohesion: 0.50
Nodes (3): INDUSTRY_SITE, GeneratedSiteContent, generateSiteContent

### Community 112 - "sitemap[.]xml.ts"
Cohesion: 0.67
Nodes (3): Route, urlEntry(), xmlEscape()

## Knowledge Gaps
- **668 isolated node(s):** `$schema`, `style`, `rsc`, `tsx`, `css` (+663 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **75 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `dependencies` to `@radix-ui/react-alert-dialog`, `@radix-ui/react-aspect-ratio`, `@radix-ui/react-avatar`, `@radix-ui/react-checkbox`, `@radix-ui/react-collapsible`, `@radix-ui/react-dialog`, `@radix-ui/react-dropdown-menu`, `devDependencies`, `@radix-ui/react-hover-card`, `@radix-ui/react-label`, `@radix-ui/react-menubar`, `@radix-ui/react-navigation-menu`, `@radix-ui/react-popover`, `@radix-ui/react-progress`, `@radix-ui/react-radio-group`, `@radix-ui/react-scroll-area`, `@radix-ui/react-select`, `@radix-ui/react-separator`, `@radix-ui/react-slider`, `@radix-ui/react-slot`, `@radix-ui/react-switch`, `@radix-ui/react-tabs`, `@radix-ui/react-toggle`, `@radix-ui/react-toggle-group`, `@radix-ui/react-tooltip`, `react-day-picker`, `react-dom`, `react-hook-form`, `react-resizable-panels`, `recharts`, `sonner`, `@supabase/supabase-js`, `tailwind-merge`, `tailwindcss`, `@tailwindcss/vite`, `@tanstack/react-query`, `@tanstack/react-router`, `@tanstack/react-start`, `@tanstack/router-plugin`, `vaul`, `vite-tsconfig-paths`, `zod`, `carousel.tsx`, `@ai-sdk/openai-compatible`, `clsx`, `cmdk`, `date-fns`, `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `embla-carousel-react`, `@hookform/resolvers`, `input-otp`, `isomorphic-dompurify`, `lucide-react`?**
  _High betweenness centrality (0.162) - this node is a cross-community bridge._
- **Why does `react` connect `carousel.tsx` to `admin/calendar.tsx`, `dependencies`, `cn`?**
  _High betweenness centrality (0.150) - this node is a cross-community bridge._
- **Why does `cn()` connect `cn` to `admin/calendar.tsx`, `sidebar.tsx`, `carousel.tsx`, `$salonId.tsx`, `utils.ts`, `client.ts`, `ServiceExportDialog.tsx`, `PublicBooking.tsx`, `AiAssistantTab.tsx`, `notifications.tsx`, `WaSimulator.tsx`, `menubar.tsx`, `dialog.tsx`, `context-menu.tsx`, `dropdown-menu.tsx`, `table.tsx`, `MasterDayOverrides.tsx`, `breadcrumb.tsx`, `drawer.tsx`, `navigation-menu.tsx`, `toggle-group.tsx`, `alert.tsx`, `input-otp.tsx`, `accordion.tsx`, `avatar.tsx`, `scroll-area.tsx`?**
  _High betweenness centrality (0.097) - this node is a cross-community bridge._
- **What connects `$schema`, `style`, `rsc` to the rest of the system?**
  _668 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `admin/calendar.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.0661189358372457 - nodes in this community are weakly interconnected._
- **Should `dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.13333333333333333 - nodes in this community are weakly interconnected._
- **Should `routeTree.gen.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06451612903225806 - nodes in this community are weakly interconnected._