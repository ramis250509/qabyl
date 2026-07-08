# Graph Report - Qabyl  (2026-07-02)

## Corpus Check
- 213 files · ~135,761 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1091 nodes · 1898 edges · 92 communities (78 shown, 14 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 27 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `5dc038de`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Appointment Booking UI|Appointment Booking UI]]
- [[_COMMUNITY_Package Dependencies|Package Dependencies]]
- [[_COMMUNITY_File-Based Routes|File-Based Routes]]
- [[_COMMUNITY_UI Layout Components|UI Layout Components]]
- [[_COMMUNITY_Core Platform Architecture|Core Platform Architecture]]
- [[_COMMUNITY_Graphify Pipeline|Graphify Pipeline]]
- [[_COMMUNITY_Notifications & Auth|Notifications & Auth]]
- [[_COMMUNITY_Build Tooling Config|Build Tooling Config]]
- [[_COMMUNITY_Branch Staff Management|Branch Staff Management]]
- [[_COMMUNITY_Salon Public Site|Salon Public Site]]
- [[_COMMUNITY_WA AI Agent Core|WA AI Agent Core]]
- [[_COMMUNITY_Salon Admin Config|Salon Admin Config]]
- [[_COMMUNITY_WA Agent Test Suite|WA Agent Test Suite]]
- [[_COMMUNITY_Salon Site & Reviews|Salon Site & Reviews]]
- [[_COMMUNITY_Core UI Primitives|Core UI Primitives]]
- [[_COMMUNITY_Public Booking Widget|Public Booking Widget]]
- [[_COMMUNITY_TypeScript Config|TypeScript Config]]
- [[_COMMUNITY_Shadcn UI Config|Shadcn UI Config]]
- [[_COMMUNITY_Menu UI Components|Menu UI Components]]
- [[_COMMUNITY_Social & Contact Links|Social & Contact Links]]
- [[_COMMUNITY_i18n Translation Layer|i18n Translation Layer]]
- [[_COMMUNITY_UI Utility Components|UI Utility Components]]
- [[_COMMUNITY_Carousel Component|Carousel Component]]
- [[_COMMUNITY_Error Handling|Error Handling]]
- [[_COMMUNITY_Date & Time Utils|Date & Time Utils]]
- [[_COMMUNITY_Form Components|Form Components]]
- [[_COMMUNITY_NLP & Intent Classification|NLP & Intent Classification]]
- [[_COMMUNITY_Chart UI Components|Chart UI Components]]
- [[_COMMUNITY_WA Chat Management|WA Chat Management]]
- [[_COMMUNITY_WA Agent Types & API|WA Agent Types & API]]
- [[_COMMUNITY_Supabase DB Types|Supabase DB Types]]
- [[_COMMUNITY_Command Palette UI|Command Palette UI]]
- [[_COMMUNITY_Context Menu UI|Context Menu UI]]
- [[_COMMUNITY_Dropdown Menu UI|Dropdown Menu UI]]
- [[_COMMUNITY_WA Config & Access|WA Config & Access]]
- [[_COMMUNITY_Table UI Component|Table UI Component]]
- [[_COMMUNITY_Branch Hours Editor|Branch Hours Editor]]
- [[_COMMUNITY_Master Day Overrides|Master Day Overrides]]
- [[_COMMUNITY_Web Push Notifications|Web Push Notifications]]
- [[_COMMUNITY_Breadcrumb UI|Breadcrumb UI]]
- [[_COMMUNITY_Drawer UI Component|Drawer UI Component]]
- [[_COMMUNITY_Navigation Menu UI|Navigation Menu UI]]
- [[_COMMUNITY_Price Formatting|Price Formatting]]
- [[_COMMUNITY_Toggle UI Components|Toggle UI Components]]
- [[_COMMUNITY_WA Webhook Helpers|WA Webhook Helpers]]
- [[_COMMUNITY_Alert UI Component|Alert UI Component]]
- [[_COMMUNITY_OTP Input Component|OTP Input Component]]
- [[_COMMUNITY_Server Config & Examples|Server Config & Examples]]
- [[_COMMUNITY_Brand Assets 512px|Brand Assets 512px]]
- [[_COMMUNITY_Avatar UI Component|Avatar UI Component]]
- [[_COMMUNITY_PWA Icons 192px|PWA Icons 192px]]
- [[_COMMUNITY_Apple Touch Icon|Apple Touch Icon]]
- [[_COMMUNITY_CORS Utilities|CORS Utilities]]
- [[_COMMUNITY_Graphify Explain Tool|Graphify Explain Tool]]
- [[_COMMUNITY_Graphify Path Tool|Graphify Path Tool]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 75|Community 75]]
- [[_COMMUNITY_Community 76|Community 76]]
- [[_COMMUNITY_Community 77|Community 77]]
- [[_COMMUNITY_Community 78|Community 78]]
- [[_COMMUNITY_Community 79|Community 79]]
- [[_COMMUNITY_Community 80|Community 80]]
- [[_COMMUNITY_Community 81|Community 81]]
- [[_COMMUNITY_Community 82|Community 82]]
- [[_COMMUNITY_Community 83|Community 83]]
- [[_COMMUNITY_Community 84|Community 84]]
- [[_COMMUNITY_Community 85|Community 85]]
- [[_COMMUNITY_Community 86|Community 86]]
- [[_COMMUNITY_Community 87|Community 87]]
- [[_COMMUNITY_Community 88|Community 88]]
- [[_COMMUNITY_Community 89|Community 89]]
- [[_COMMUNITY_Community 90|Community 90]]
- [[_COMMUNITY_Community 91|Community 91]]

## God Nodes (most connected - your core abstractions)
1. `cn()` - 72 edges
2. `runWaAgentV3()` - 32 edges
3. `supabase` - 25 edges
4. `Graphify Full Pipeline Skill` - 24 edges
5. `Button` - 20 edges
6. `runWaAgent()` - 20 edges
7. `Card` - 18 edges
8. `useAuth()` - 18 edges
9. `compilerOptions` - 17 edges
10. `fetch()` - 16 edges

## Surprising Connections (you probably didn't know these)
- `sendGreenApi()` --calls--> `fetch()`  [INFERRED]
  supabase/functions/send-whatsapp/index.ts → src/server.ts
- `WA State Machine Design` --rationale_for--> `WhatsApp AI Assistant (wa-agent.server.ts)`  [INFERRED]
  .lovable/plan.md → CLAUDE.md
- `create_appointment RPC (extended with _price_override)` --shares_data_with--> `Supabase (Auth + Postgres + Storage)`  [INFERRED]
  .lovable/plan.md → CLAUDE.md
- `WA Agent Architecture Plan (Lovable plan.md)` --conceptually_related_to--> `WhatsApp AI Assistant (wa-agent.server.ts)`  [INFERRED]
  .lovable/plan.md → CLAUDE.md
- `Gemini Thinking Budget (5000 tokens)` --conceptually_related_to--> `Gemini as Intent Classifier (not tool-loop)`  [INFERRED]
  WA_AGENT_IMPROVEMENTS.md → .lovable/plan.md

## Import Cycles
- 3-file cycle: `src/components/site/SalonSite.tsx -> src/components/site/templates/MinimalTemplate.tsx -> src/components/site/sections.tsx -> src/components/site/SalonSite.tsx`
- 3-file cycle: `src/components/site/SalonSite.tsx -> src/components/site/templates/PremiumTemplate.tsx -> src/components/site/sections.tsx -> src/components/site/SalonSite.tsx`
- 3-file cycle: `src/components/site/SalonSite.tsx -> src/components/site/templates/VividTemplate.tsx -> src/components/site/sections.tsx -> src/components/site/SalonSite.tsx`

## Hyperedges (group relationships)
- **WA Agent Core Architecture (state machine + lock + Gemini classifier)** — lovable_plan_state_machine, lovable_plan_advisory_lock, lovable_plan_gemini_intent_classifier [EXTRACTED 0.95]
- **Graphify Extraction Pipeline (AST + semantic + merge)** — graphify_skill_ast_extraction, graphify_skill_semantic_extraction, graphify_skill_extraction_cache [EXTRACTED 1.00]
- **WA Agent NLP Improvements (fuzzy + intent + yes/no detection)** — wa_agent_improvements_fuzzy_matching, wa_agent_improvements_intent_promotion, wa_agent_improvements_yes_no_detection, wa_agent_improvements_master_name_matching [EXTRACTED 1.00]

## Communities (92 total, 14 thin omitted)

### Community 0 - "Appointment Booking UI"
Cohesion: 0.17
Nodes (17): CreateAppointmentDialog(), DateQuickPicker(), Master, MoveAppointmentDialog(), Service, TIME_OPTIONS, DayGrid(), PositionedBlock() (+9 more)

### Community 1 - "Package Dependencies"
Cohesion: 0.03
Nodes (62): dependencies, ai, @ai-sdk/openai-compatible, class-variance-authority, clsx, cmdk, date-fns, @dnd-kit/core (+54 more)

### Community 2 - "File-Based Routes"
Cohesion: 0.05
Nodes (46): Route, Route, Route, Route, consumeLastCapturedError(), renderErrorPage(), Route, Route (+38 more)

### Community 3 - "UI Layout Components"
Cohesion: 0.06
Nodes (36): Separator, SheetContent, SheetContentProps, SheetDescription, SheetFooter(), SheetHeader(), SheetOverlay, SheetTitle (+28 more)

### Community 4 - "Core Platform Architecture"
Cohesion: 0.07
Nodes (35): createServerFn Pattern (server functions), Green-API (WhatsApp Integration), i18n Layer (ru/ky/en, useT() hook), Qabyl Project (Beauty Salon Booking Platform), routeTree.gen.ts (auto-generated, never edit), Supabase (Auth + Postgres + Storage), supabaseAdmin (service role, bypasses RLS), Supabase Client (RLS-respecting, browser) (+27 more)

### Community 5 - "Graphify Pipeline"
Cohesion: 0.11
Nodes (20): AST Structural Extraction (Part A), Community Detection, Extraction Cache (check_semantic_cache), God Nodes Analysis, Interactive HTML Graph Output, GRAPH_REPORT.md Output, Graphify Full Pipeline Skill, Graphify Query (BFS/DFS traversal) (+12 more)

### Community 6 - "Notifications & Auth"
Cohesion: 0.25
Nodes (17): NotificationsPage(), useNotifications(), BUILD_VAPID_PUBLIC_KEY, debugLog(), disablePushSubscription(), EnsurePushOptions, ensurePushSubscription(), getOrRegisterSW() (+9 more)

### Community 7 - "Build Tooling Config"
Cohesion: 0.11
Nodes (18): devDependencies, eslint, eslint-config-prettier, @eslint/js, eslint-plugin-prettier, eslint-plugin-react-hooks, eslint-plugin-react-refresh, globals (+10 more)

### Community 8 - "Branch Staff Management"
Cohesion: 0.07
Nodes (25): assertCanManageBranch(), createBranchMaster, listBranchMasters, revokeBranchMaster, WORDS, createSalonAdmin, listSalonAdmins, revokeSalonAdmin (+17 more)

### Community 9 - "Salon Public Site"
Cohesion: 0.18
Nodes (14): useT(), SalonSiteData, DAYS_RU, NAV_LABEL_KEYS, NavLinks(), SiteContacts(), SiteFaq(), SiteFooter() (+6 more)

### Community 10 - "WA AI Agent Core"
Cohesion: 0.08
Nodes (18): AdminClient, DbMaster, Entities, formatTimeInTz(), GeminiContent, GeminiPart, GeminiV2Content, Intent (+10 more)

### Community 11 - "Salon Admin Config"
Cohesion: 0.09
Nodes (12): BranchHoursEditor(), defaultBranchHours(), BranchDialog(), IntegrationsTab(), SalonEdit(), SalonScheduleCard(), SCHEDULE_DOW_KEYS, TIMEZONES (+4 more)

### Community 12 - "WA Agent Test Suite"
Cohesion: 0.10
Nodes (20): BRANCHES, branchSalon(), composeSystemInstructions, CONFIG, convo(), convoV3(), DAY_AFTER, dbProxy (+12 more)

### Community 13 - "Salon Site & Reviews"
Cohesion: 0.14
Nodes (14): AiAssistantTab(), Assistant, ChatMessage, HistoryMsg, InteractiveMessage, WaSimulator(), WaState, WaAgentStateData (+6 more)

### Community 14 - "Core UI Primitives"
Cohesion: 0.21
Nodes (12): cn(), Pagination(), PaginationContent, PaginationEllipsis(), PaginationItem, PaginationLink(), PaginationLinkProps, PaginationNext() (+4 more)

### Community 15 - "Public Booking Widget"
Cohesion: 0.11
Nodes (10): Branch, BranchContactsBar(), Faq, formatDuration(), Master, PublicBooking(), Salon, Service (+2 more)

### Community 16 - "TypeScript Config"
Cohesion: 0.10
Nodes (19): compilerOptions, allowImportingTsExtensions, jsx, lib, module, moduleResolution, noEmit, noFallthroughCasesInSwitch (+11 more)

### Community 17 - "Shadcn UI Config"
Cohesion: 0.11
Nodes (18): aliases, components, hooks, lib, ui, utils, iconLibrary, registries (+10 more)

### Community 18 - "Menu UI Components"
Cohesion: 0.12
Nodes (11): Menubar, MenubarCheckboxItem, MenubarContent, MenubarItem, MenubarLabel, MenubarRadioItem, MenubarSeparator, MenubarShortcut() (+3 more)

### Community 19 - "Social & Contact Links"
Cohesion: 0.17
Nodes (5): AdminBranch, AdminSalon, AppNotification, signOutFromApp(), supabase

### Community 20 - "i18n Translation Layer"
Cohesion: 0.61
Nodes (7): CalendarPage(), Dashboard(), StatsPage(), useAdminFilters(), useAuth(), useRegisterRefresh(), useSalonTimezone()

### Community 21 - "UI Utility Components"
Cohesion: 0.12
Nodes (10): Alert, AlertDescription, AlertTitle, alertVariants, HoverCardContent, PopoverContent, Progress, ScrollArea (+2 more)

### Community 22 - "Carousel Component"
Cohesion: 0.14
Nodes (12): Carousel, CarouselApi, CarouselContent, CarouselContext, CarouselContextProps, CarouselItem, CarouselNext, CarouselOptions (+4 more)

### Community 23 - "Error Handling"
Cohesion: 0.16
Nodes (11): BranchHours, WEEKDAYS, Kind, MasterDayOverrides(), Override, Checkbox, Input, Label (+3 more)

### Community 24 - "Date & Time Utils"
Cohesion: 0.20
Nodes (12): availablePartsToday(), clampLanguage(), confidentLanguage(), executeV2Tool(), fetchMergedSlots(), formatDateInTz(), isInPart(), loadAiVisibleServicesForSalon() (+4 more)

### Community 25 - "Form Components"
Cohesion: 0.17
Nodes (9): FormControl, FormDescription, FormFieldContext, FormFieldContextValue, FormItem, FormItemContext, FormItemContextValue, FormLabel (+1 more)

### Community 26 - "NLP & Intent Classification"
Cohesion: 0.25
Nodes (11): classify(), deElongate(), detectLanguage(), deterministicParse(), findServiceByText(), fuzzyHit(), levenshtein(), matchMasterByName() (+3 more)

### Community 27 - "Chart UI Components"
Cohesion: 0.18
Nodes (7): ChartConfig, ChartContainer, ChartContext, ChartContextProps, ChartLegendContent, ChartTooltipContent, THEMES

### Community 28 - "WA Chat Management"
Cohesion: 0.20
Nodes (12): normalizeSocial(), normalizeWhatsApp(), socialLinkProps, Branch, BranchContactCard(), BranchesContactsBlock(), BranchVariant, VARIANT_STYLES (+4 more)

### Community 29 - "WA Agent Types & API"
Cohesion: 0.12
Nodes (17): callGeminiV3Faq(), callViaLovableGateway(), downloadImageAsBase64(), GreenApiCreds, greenApiSendButtons(), greenApiSendFileByUrl(), greenApiSendListMessage(), greenApiSendMessage() (+9 more)

### Community 30 - "Supabase DB Types"
Cohesion: 0.13
Nodes (13): Architecture, Auth and roles, Commands, Environment variables, File-based routing (`src/routes/`), graphify, i18n, Project (+5 more)

### Community 31 - "Command Palette UI"
Cohesion: 0.20
Nodes (8): Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut()

### Community 32 - "Context Menu UI"
Cohesion: 0.20
Nodes (9): ContextMenuCheckboxItem, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuRadioItem, ContextMenuSeparator, ContextMenuShortcut(), ContextMenuSubContent (+1 more)

### Community 33 - "Dropdown Menu UI"
Cohesion: 0.20
Nodes (9): DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuShortcut(), DropdownMenuSubContent (+1 more)

### Community 34 - "WA Config & Access"
Cohesion: 0.15
Nodes (8): Ctx, DICT, I18nContext, I18nProvider(), Lang, LanguageSwitcher(), Toaster(), ToasterProps

### Community 35 - "Table UI Component"
Cohesion: 0.22
Nodes (8): Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow

### Community 36 - "Branch Hours Editor"
Cohesion: 0.14
Nodes (13): 10. Технические детали реализации, 11. Файлы, которые меняются, 12. Проверка после имплементации, 13. Что НЕ делаем в этом плане, 1. Архитектурное замечание (важно), 2. Миграция БД (lock + state machine + цена), 3. Секрет, 4. Анти-гонка вебхуков (Green-API часто шлёт два webhook'а параллельно) (+5 more)

### Community 37 - "Master Day Overrides"
Cohesion: 0.18
Nodes (14): addDaysISO(), buildBranchListMsg(), buildConfirmMsg(), buildDateListMsg(), buildDateMap(), buildManageActionMsg(), buildManageChoiceMsg(), buildMasterListMsg() (+6 more)

### Community 38 - "Web Push Notifications"
Cohesion: 0.29
Nodes (7): b64urlDecode(), cors, isValidVapidPublic(), supabase, VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY, VAPID_SUBJECT

### Community 39 - "Breadcrumb UI"
Cohesion: 0.25
Nodes (7): Breadcrumb, BreadcrumbEllipsis(), BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator()

### Community 40 - "Drawer UI Component"
Cohesion: 0.25
Nodes (6): DrawerContent, DrawerDescription, DrawerFooter(), DrawerHeader(), DrawerOverlay, DrawerTitle

### Community 41 - "Navigation Menu UI"
Cohesion: 0.25
Nodes (7): NavigationMenu, NavigationMenuContent, NavigationMenuIndicator, NavigationMenuList, NavigationMenuTrigger, navigationMenuTriggerStyle, NavigationMenuViewport

### Community 42 - "Price Formatting"
Cohesion: 0.14
Nodes (13): 1. **Enabled Gemini Thinking Budget** (Line 289), 2. **Increased Intent Classification Temperature** (Line 729), 3. **Improved Service Fuzzy Matching** (Line 438, 444), 4. **Better Master Name Matching** (Line 1269-1280), 5. **Smarter Intent Promotion Logic** (Line 621-632), 6. **Enhanced Yes/No Detection** (Line 508-516), 7. **More Tolerant Time/Part-of-Day Parsing** (Line 491-505), 8. **Slightly Higher Reply Temperature** (Line 819) (+5 more)

### Community 43 - "Toggle UI Components"
Cohesion: 0.33
Nodes (5): ToggleGroup, ToggleGroupContext, ToggleGroupItem, Toggle, toggleVariants

### Community 44 - "WA Webhook Helpers"
Cohesion: 0.40
Nodes (3): corsHeaders, readGreenApiBody(), sendGreenApi()

### Community 45 - "Alert UI Component"
Cohesion: 0.11
Nodes (17): Density, DENSITY_LABEL, DENSITY_ORDER, DragData, HOUR_PX_BY_DENSITY, ConflictInfo, RestoreTarget, useIsMobile() (+9 more)

### Community 46 - "OTP Input Component"
Cohesion: 0.40
Nodes (4): InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot

### Community 48 - "Brand Assets 512px"
Cohesion: 0.83
Nodes (4): Qabyl App Icon (512px), Qabyl Brand Identity, Teal-to-Pink Gradient Background, Stylized Q Logo Mark

### Community 49 - "Avatar UI Component"
Cohesion: 0.50
Nodes (3): Avatar, AvatarFallback, AvatarImage

### Community 50 - "PWA Icons 192px"
Cohesion: 1.00
Nodes (3): Qabyl App Icon (192px PWA), Qabyl Brand Identity — Q lettermark with teal-to-pink gradient, Progressive Web App (PWA) Icon Asset 192x192

### Community 61 - "Community 61"
Cohesion: 0.27
Nodes (10): BranchFilterBar(), Filters, Card, SelectContent, SelectItem, SelectLabel, SelectScrollDownButton, SelectScrollUpButton (+2 more)

### Community 62 - "Community 62"
Cohesion: 0.27
Nodes (7): SalonsList(), DialogContent, DialogDescription, DialogFooter(), DialogHeader(), DialogOverlay, DialogTitle

### Community 63 - "Community 63"
Cohesion: 0.18
Nodes (10): For /graphify add and --watch, For /graphify query, For the commit hook and native CLAUDE.md integration, For --update and --cluster-only, /graphify, Interpreter guard for subcommands, PowerShell 5.1: Vertical scrolling stops working, Troubleshooting (+2 more)

### Community 64 - "Community 64"
Cohesion: 0.18
Nodes (11): Step 0 - GitHub repos and multi-path merge (only if a URL or several paths), Step 1 - Ensure graphify is installed, Step 2.5 - Video and audio (only if video files detected), Step 2 - Detect files, Step 4.5 - Graph health check (read-only integrity gate), Step 4 - Build graph, cluster, analyze, generate outputs, Step 5 - Label communities, Step 6 - Generate Obsidian vault (opt-in) + HTML (+3 more)

### Community 65 - "Community 65"
Cohesion: 0.22
Nodes (8): graphify reference: extra exports and benchmark, Step 6b - Wiki (only if --wiki flag), Step 7 - Neo4j export (only if --neo4j or --neo4j-push flag), Step 7a - FalkorDB export (only if --falkordb or --falkordb-push flag), Step 7b - SVG export (only if --svg flag), Step 7c - GraphML export (only if --graphml flag), Step 7d - MCP server (only if --mcp flag), Step 8 - Token reduction benchmark (only if total_words > 5000)

### Community 66 - "Community 66"
Cohesion: 0.25
Nodes (5): CONFIG, dbProxy, SALON, SERVICE, visionQueue

### Community 67 - "Community 67"
Cohesion: 0.33
Nodes (5): For /graphify explain, For /graphify path, graphify reference: query, path, explain, Step 0 — Constrained query expansion (REQUIRED before traversal), Step 1 — Traversal

### Community 68 - "Community 68"
Cohesion: 0.22
Nodes (9): AiServiceListEditor(), Override, ServiceRow, SalonShareCard(), Button, ButtonProps, buttonVariants, Calendar() (+1 more)

### Community 69 - "Community 69"
Cohesion: 0.50
Nodes (4): Honesty Rules, Confidence Score Rubric (EXTRACTED/INFERRED/AMBIGUOUS), Node ID Format Rules, Extraction Subagent Prompt Spec

### Community 70 - "Community 70"
Cohesion: 0.50
Nodes (4): Part A - Structural extraction for code files, Part B - Semantic extraction (parallel subagents), Part C - Merge AST + semantic into final extraction, Step 3 - Extract entities and relationships

### Community 71 - "Community 71"
Cohesion: 0.50
Nodes (3): For /graphify add, For --watch, graphify reference: add a URL and watch a folder

### Community 72 - "Community 72"
Cohesion: 0.50
Nodes (3): For git commit hook, For native CLAUDE.md integration, graphify reference: commit hook and native CLAUDE.md integration

### Community 73 - "Community 73"
Cohesion: 0.50
Nodes (4): BFS Graph Traversal (Query Mode), DFS Graph Traversal (Query Mode), Save-Result Feedback Loop (self-improving), Query Vocab Expansion (constrained token matching)

### Community 74 - "Community 74"
Cohesion: 0.50
Nodes (3): For --cluster-only, For --update (incremental re-extraction), graphify reference: incremental update and cluster-only

### Community 84 - "Community 84"
Cohesion: 0.20
Nodes (10): Conversation, Message, needsHuman(), statusBadge(), WaChatsTab(), CardContent, CardDescription, CardFooter (+2 more)

### Community 85 - "Community 85"
Cohesion: 0.38
Nodes (6): fmt(), formatPrice(), formatPriceShort(), ServicePrice, ServiceRow(), ServiceCard()

### Community 86 - "Community 86"
Cohesion: 0.17
Nodes (11): name, private, scripts, build, build:dev, dev, format, lint (+3 more)

### Community 87 - "Community 87"
Cohesion: 0.40
Nodes (5): callGemini(), classifyManageIntentV3(), compose(), instructionFallbackReply(), priceFromPhoto()

### Community 88 - "Community 88"
Cohesion: 0.31
Nodes (6): ReviewsTab(), DAYS, SiteTab(), TEMPLATES, Switch, Textarea

### Community 89 - "Community 89"
Cohesion: 0.32
Nodes (6): RefreshContext, RefreshContextValue, RefreshFn, RefreshProvider(), useRefreshController(), PullToRefresh()

### Community 90 - "Community 90"
Cohesion: 0.50
Nodes (4): buildSystemPromptV2(), callGeminiTools(), getAdmin(), runWaAgentV2()

### Community 91 - "Community 91"
Cohesion: 0.50
Nodes (3): AccordionContent, AccordionItem, AccordionTrigger

## Knowledge Gaps
- **522 isolated node(s):** `$schema`, `style`, `rsc`, `tsx`, `css` (+517 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `cn()` connect `Core UI Primitives` to `UI Layout Components`, `Salon Admin Config`, `Salon Site & Reviews`, `Public Booking Widget`, `Menu UI Components`, `UI Utility Components`, `Carousel Component`, `Error Handling`, `Form Components`, `Chart UI Components`, `Command Palette UI`, `Context Menu UI`, `Dropdown Menu UI`, `Table UI Component`, `Breadcrumb UI`, `Drawer UI Component`, `Navigation Menu UI`, `Toggle UI Components`, `Alert UI Component`, `OTP Input Component`, `Avatar UI Component`, `Community 61`, `Community 62`, `Community 68`, `Community 84`, `Community 88`, `Community 91`?**
  _High betweenness centrality (0.097) - this node is a cross-community bridge._
- **Why does `Button` connect `Community 68` to `Appointment Booking UI`, `File-Based Routes`, `UI Layout Components`, `Notifications & Auth`, `Salon Admin Config`, `Alert UI Component`, `Salon Site & Reviews`, `Public Booking Widget`, `Social & Contact Links`, `Carousel Component`, `Error Handling`, `Community 88`, `Community 62`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **Why does `supabase` connect `Social & Contact Links` to `Appointment Booking UI`, `File-Based Routes`, `Community 68`, `Notifications & Auth`, `Salon Admin Config`, `Alert UI Component`, `Salon Site & Reviews`, `Public Booking Widget`, `i18n Translation Layer`, `Community 84`, `Error Handling`, `Community 88`, `WA Chat Management`, `Community 61`, `Community 62`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **What connects `$schema`, `style`, `rsc` to the rest of the system?**
  _525 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Package Dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.03225806451612903 - nodes in this community are weakly interconnected._
- **Should `File-Based Routes` be split into smaller, more focused modules?**
  _Cohesion score 0.05026300409117475 - nodes in this community are weakly interconnected._
- **Should `UI Layout Components` be split into smaller, more focused modules?**
  _Cohesion score 0.05609756097560976 - nodes in this community are weakly interconnected._