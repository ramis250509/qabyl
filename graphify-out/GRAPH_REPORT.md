# Graph Report - .  (2026-06-28)

## Corpus Check
- 205 files · ~113,477 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 918 nodes · 1650 edges · 61 communities (56 shown, 5 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 19 edges (avg confidence: 0.89)
- Token cost: 0 input · 0 output

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

## God Nodes (most connected - your core abstractions)
1. `cn()` - 72 edges
2. `supabase` - 24 edges
3. `Graphify Full Pipeline Skill` - 24 edges
4. `runWaAgent()` - 20 edges
5. `Button` - 18 edges
6. `useAuth()` - 18 edges
7. `compilerOptions` - 17 edges
8. `Card` - 16 edges
9. `Input` - 14 edges
10. `FileRoutesByPath` - 14 edges

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

## Communities (61 total, 5 thin omitted)

### Community 0 - "Appointment Booking UI"
Cohesion: 0.05
Nodes (67): CreateAppointmentDialog(), DateQuickPicker(), Master, MoveAppointmentDialog(), Service, TIME_OPTIONS, BranchFilterBar(), Filters (+59 more)

### Community 1 - "Package Dependencies"
Cohesion: 0.03
Nodes (62): dependencies, ai, @ai-sdk/openai-compatible, class-variance-authority, clsx, cmdk, date-fns, @dnd-kit/core (+54 more)

### Community 2 - "File-Based Routes"
Cohesion: 0.06
Nodes (39): Route, Route, Route, Route, Route, Route, Route, Route (+31 more)

### Community 3 - "UI Layout Components"
Cohesion: 0.06
Nodes (36): Separator, SheetContent, SheetContentProps, SheetDescription, SheetFooter(), SheetHeader(), SheetOverlay, SheetTitle (+28 more)

### Community 4 - "Core Platform Architecture"
Cohesion: 0.07
Nodes (35): createServerFn Pattern (server functions), Green-API (WhatsApp Integration), i18n Layer (ru/ky/en, useT() hook), Qabyl Project (Beauty Salon Booking Platform), routeTree.gen.ts (auto-generated, never edit), Supabase (Auth + Postgres + Storage), supabaseAdmin (service role, bypasses RLS), Supabase Client (RLS-respecting, browser) (+27 more)

### Community 5 - "Graphify Pipeline"
Cohesion: 0.06
Nodes (34): Graphify Skill Reference (Claude CLAUDE.md), AST Structural Extraction (Part A), Community Detection, Extraction Cache (check_semantic_cache), God Nodes Analysis, Interactive HTML Graph Output, GRAPH_REPORT.md Output, Graphify Full Pipeline Skill (+26 more)

### Community 6 - "Notifications & Auth"
Cohesion: 0.14
Nodes (25): NotificationsPage(), AppNotification, useNotifications(), signOutFromApp(), BUILD_VAPID_PUBLIC_KEY, debugLog(), disablePushSubscription(), EnsurePushOptions (+17 more)

### Community 7 - "Build Tooling Config"
Cohesion: 0.07
Nodes (29): devDependencies, eslint, eslint-config-prettier, @eslint/js, eslint-plugin-prettier, eslint-plugin-react-hooks, eslint-plugin-react-refresh, globals (+21 more)

### Community 8 - "Branch Staff Management"
Cohesion: 0.09
Nodes (17): assertCanManageBranch(), createBranchMaster, listBranchMasters, revokeBranchMaster, WORDS, createSalonAdmin, listSalonAdmins, revokeSalonAdmin (+9 more)

### Community 9 - "Salon Public Site"
Cohesion: 0.18
Nodes (14): useT(), SalonSiteData, DAYS_RU, NAV_LABEL_KEYS, NavLinks(), SiteContacts(), SiteFaq(), SiteFooter() (+6 more)

### Community 10 - "WA AI Agent Core"
Cohesion: 0.11
Nodes (18): AdminClient, callGemini(), compose(), DbMaster, Entities, fetchMergedSlots(), GeminiContent, GeminiPart (+10 more)

### Community 11 - "Salon Admin Config"
Cohesion: 0.10
Nodes (7): IntegrationsTab(), SalonEdit(), TIMEZONES, WEEKDAYS, TabsContent, TabsList, TabsTrigger

### Community 12 - "WA Agent Test Suite"
Cohesion: 0.11
Nodes (16): BRANCHES, branchSalon(), composeSystemInstructions, CONFIG, convo(), DAY_AFTER, dbProxy, geminiClassifyQueue (+8 more)

### Community 13 - "Salon Site & Reviews"
Cohesion: 0.18
Nodes (12): ReviewsTab(), SalonShareCard(), DAYS, SiteTab(), TEMPLATES, Route, Button, Input (+4 more)

### Community 14 - "Core UI Primitives"
Cohesion: 0.18
Nodes (16): cn(), ButtonProps, buttonVariants, Calendar(), CalendarDayButton(), Pagination(), PaginationContent, PaginationEllipsis() (+8 more)

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
Cohesion: 0.20
Nodes (12): normalizeSocial(), normalizeWhatsApp(), socialLinkProps, Branch, BranchContactCard(), BranchesContactsBlock(), BranchVariant, VARIANT_STYLES (+4 more)

### Community 20 - "i18n Translation Layer"
Cohesion: 0.15
Nodes (8): Ctx, DICT, I18nContext, I18nProvider(), Lang, LanguageSwitcher(), Toaster(), ToasterProps

### Community 21 - "UI Utility Components"
Cohesion: 0.14
Nodes (8): AccordionContent, AccordionItem, AccordionTrigger, HoverCardContent, Progress, ScrollArea, ScrollBar, Slider

### Community 22 - "Carousel Component"
Cohesion: 0.14
Nodes (12): Carousel, CarouselApi, CarouselContent, CarouselContext, CarouselContextProps, CarouselItem, CarouselNext, CarouselOptions (+4 more)

### Community 23 - "Error Handling"
Cohesion: 0.27
Nodes (8): consumeLastCapturedError(), renderErrorPage(), downloadImageAsBase64(), greenApiSendMessage(), fetch(), getServerEntry(), normalizeCatastrophicSsrResponse(), ServerEntry

### Community 24 - "Date & Time Utils"
Cohesion: 0.20
Nodes (12): addDaysISO(), availablePartsToday(), buildDateMap(), clampLanguage(), confidentLanguage(), formatDateInTz(), formatTimeInTz(), loadMastersForService() (+4 more)

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
Cohesion: 0.29
Nodes (8): Conversation, Message, needsHuman(), statusBadge(), WaChatsTab(), Badge(), BadgeProps, badgeVariants

### Community 29 - "WA Agent Types & API"
Cohesion: 0.20
Nodes (7): GreenApiCreds, normalizeChatIdToPhone(), WaAgentInput, WaAgentState, WaBranchInfo, WaIncomingMessage, Route

### Community 30 - "Supabase DB Types"
Cohesion: 0.20
Nodes (9): CompositeTypes, Constants, DatabaseWithoutInternals, DefaultSchema, Enums, Json, Tables, TablesInsert (+1 more)

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
Cohesion: 0.28
Nodes (4): AiAssistantTab(), Assistant, getWaWebhookConfig, regenerateWaWebhookToken

### Community 35 - "Table UI Component"
Cohesion: 0.22
Nodes (8): Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow

### Community 36 - "Branch Hours Editor"
Cohesion: 0.32
Nodes (6): BranchHours, BranchHoursEditor(), defaultBranchHours(), WEEKDAYS, BranchDialog(), Checkbox

### Community 37 - "Master Day Overrides"
Cohesion: 0.32
Nodes (5): Kind, MasterDayOverrides(), Override, RadioGroup, RadioGroupItem

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
Cohesion: 0.38
Nodes (6): fmt(), formatPrice(), formatPriceShort(), ServicePrice, ServiceRow(), ServiceCard()

### Community 43 - "Toggle UI Components"
Cohesion: 0.33
Nodes (5): ToggleGroup, ToggleGroupContext, ToggleGroupItem, Toggle, toggleVariants

### Community 44 - "WA Webhook Helpers"
Cohesion: 0.40
Nodes (3): corsHeaders, readGreenApiBody(), sendGreenApi()

### Community 45 - "Alert UI Component"
Cohesion: 0.40
Nodes (4): Alert, AlertDescription, AlertTitle, alertVariants

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

## Knowledge Gaps
- **425 isolated node(s):** `$schema`, `style`, `rsc`, `tsx`, `css` (+420 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `cn()` connect `Core UI Primitives` to `Appointment Booking UI`, `File-Based Routes`, `UI Layout Components`, `Salon Admin Config`, `Salon Site & Reviews`, `Public Booking Widget`, `Menu UI Components`, `UI Utility Components`, `Carousel Component`, `Form Components`, `Chart UI Components`, `WA Chat Management`, `Command Palette UI`, `Context Menu UI`, `Dropdown Menu UI`, `Table UI Component`, `Branch Hours Editor`, `Master Day Overrides`, `Breadcrumb UI`, `Drawer UI Component`, `Navigation Menu UI`, `Toggle UI Components`, `Alert UI Component`, `OTP Input Component`, `Avatar UI Component`?**
  _High betweenness centrality (0.124) - this node is a cross-community bridge._
- **Why does `Button` connect `Salon Site & Reviews` to `Appointment Booking UI`, `WA Config & Access`, `File-Based Routes`, `UI Layout Components`, `Master Day Overrides`, `Notifications & Auth`, `Salon Admin Config`, `Core UI Primitives`, `Public Booking Widget`, `Carousel Component`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **Why does `supabase` connect `Appointment Booking UI` to `WA Config & Access`, `File-Based Routes`, `Master Day Overrides`, `Notifications & Auth`, `Salon Admin Config`, `Salon Site & Reviews`, `Public Booking Widget`, `Social & Contact Links`, `WA Chat Management`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **What connects `$schema`, `style`, `rsc` to the rest of the system?**
  _428 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Appointment Booking UI` be split into smaller, more focused modules?**
  _Cohesion score 0.05304982817869416 - nodes in this community are weakly interconnected._
- **Should `Package Dependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.03225806451612903 - nodes in this community are weakly interconnected._
- **Should `File-Based Routes` be split into smaller, more focused modules?**
  _Cohesion score 0.05803921568627451 - nodes in this community are weakly interconnected._