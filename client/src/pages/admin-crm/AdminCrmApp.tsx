import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  CheckCircle2,
  Eye,
  FileWarning,
  HeartPulse,
  Home,
  LayoutDashboard,
  Lock,
  LineChart,
  LogOut,
  MessageSquare,
  Shield,
  ShieldAlert,
  Ticket,
  UserPlus,
  Users,
  Wallet,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { HelpTip } from "./HelpTip";
import InboxWorkspace from "./InboxWorkspace";
import InsightsWorkspace from "./InsightsWorkspace";
import PeopleWorkspace from "./PeopleWorkspace";
import QuickActionDialog from "./QuickActionDialog";
import { crm } from "./theme";
import { CRM_CHECKLIST, PHASE_LABELS, type CrmAccess, type CrmOverview, type CrmSection } from "./types";


function phaseLabel(phase: string) {
  if (phase === "churned") return PHASE_LABELS.dormant;
  return PHASE_LABELS[phase] || phase;
}

function roleLabel(role: string) {
  const map: Record<string, string> = {
    owner: "Owner · full access",
    viewer: "Viewer · read only",
    editor: "Editor · can edit",
    support: "Support · tickets",
  };
  return map[role] || role;
}

type PeopleNav = { userId?: number | null; phaseFilter?: string; typeFilter?: string };

export default function AdminCrmApp() {
  const { user, logoutMutation } = useAuth();
  const { toast } = useToast();
  const [section, setSection] = useState<CrmSection>("home");
  const [quickActionOpen, setQuickActionOpen] = useState(false);
  const [peopleNav, setPeopleNav] = useState<PeopleNav>({});
  const [entityFilter, setEntityFilter] = useState("all");
  const [staffForm, setStaffForm] = useState({
    username: "",
    password: "",
    displayName: "",
    role: "viewer",
  });
  const [showChecklist, setShowChecklist] = useState(false);

  const crmAccess = ((user as any)?.crmAccess || null) as CrmAccess | null;
  const canUseCrm = !!crmAccess;

  const overviewQuery = useQuery<CrmOverview>({
    queryKey: ["/api/crm/overview"],
    enabled: canUseCrm,
  });

  const revenueQuery = useQuery<any>({
    queryKey: ["/api/crm/revenue", entityFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (entityFilter !== "all") params.set("entity", entityFilter);
      const res = await apiRequest("GET", `/api/crm/revenue?${params.toString()}`);
      return res.json();
    },
    enabled: canUseCrm && !!crmAccess?.canViewRevenue && section === "money",
  });

  const creditHealthQuery = useQuery<any>({
    queryKey: ["/api/crm/credits/health"],
    enabled: canUseCrm && !!crmAccess?.canViewUsers && (section === "money" || section === "home"),
    refetchInterval: 10000,
  });

  const auditQuery = useQuery<{ logs: any[] }>({
    queryKey: ["/api/crm/audit-logs"],
    enabled: canUseCrm && !!crmAccess?.canViewAudit && (section === "audit" || section === "home"),
  });

  const ticketsPreviewQuery = useQuery<{ tickets: any[] }>({
    queryKey: ["/api/crm/tickets", "preview", "open"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/crm/tickets?status=open");
      return res.json();
    },
    enabled: canUseCrm && !!crmAccess?.canManageTickets && section === "home",
  });

  const staffQuery = useQuery<{ staff: any[] }>({
    queryKey: ["/api/crm/staff"],
    enabled: canUseCrm && !!crmAccess?.canManageStaff && section === "team",
  });

  const rollbackMutation = useMutation({
    mutationFn: async (logId: number) => {
      const res = await apiRequest("POST", `/api/crm/audit-logs/${logId}/rollback`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Rolled back", description: "Previous values restored." });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/audit-logs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/users"] });
    },
    onError: (err: any) => toast({ title: "Rollback failed", description: err.message, variant: "destructive" }),
  });

  const reconcileCreditsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/crm/credits/reconcile");
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Credit ledgers reconciled",
        description: `${data.transactionsRepaired || 0} transaction snapshots repaired and ${data.grantsAdded || 0} grant records added.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/credits/health"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/overview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/revenue"] });
    },
    onError: (err: any) => toast({ title: "Credit reconciliation failed", description: err.message, variant: "destructive" }),
  });

  const createStaffMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/crm/staff", staffForm);
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Staff login created", description: data.message });
      setStaffForm({ username: "", password: "", displayName: "", role: "viewer" });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/staff"] });
    },
    onError: (err: any) => toast({ title: "Could not create staff", description: err.message, variant: "destructive" }),
  });

  const updateStaffMutation = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: Record<string, unknown> }) => {
      const res = await apiRequest("PATCH", `/api/crm/staff/${id}`, patch);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Staff updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/staff"] });
    },
    onError: (err: any) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });

  const resolveTicketMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("PATCH", `/api/crm/tickets/${id}`, { status: "resolved" });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/crm/tickets"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/overview"] });
    },
  });

  const nav = useMemo(() => {
    const items: { id: CrmSection; label: string; hint: string; icon: any; show: boolean }[] = [
      { id: "home", label: "Home", hint: "Today's overview", icon: Home, show: true },
      { id: "people", label: "People", hint: "Clients & healers", icon: Users, show: !!crmAccess?.canViewUsers },
      { id: "money", label: "Money", hint: "Payments & credits", icon: Wallet, show: !!crmAccess?.canViewRevenue },
      {
        id: "inbox",
        label: "Messages & leads",
        hint: "Support + sales",
        icon: MessageSquare,
        show: !!crmAccess?.canManageTickets || !!crmAccess?.canViewUsers,
      },
      { id: "team", label: "Team access", hint: "Staff logins", icon: UserPlus, show: !!crmAccess?.canManageStaff },
      { id: "insights", label: "Insights", hint: "Daily logs & traffic", icon: LineChart, show: !!crmAccess?.canViewUsers },
      { id: "audit", label: "Activity log", hint: "Who changed what", icon: Shield, show: !!crmAccess?.canViewAudit },
    ];
    return items.filter((i) => i.show);
  }, [crmAccess]);

  const goToPeople = (opts: PeopleNav = {}) => {
    setPeopleNav(opts);
    setSection("people");
  };

  if (!user) {
    return (
      <div className={`${crm.page} items-center justify-center text-slate-700 p-6`}>
        <p className="text-center mb-4">Please log in first.</p>
        <Link href="/auth">
          <Button className={crm.btnPrimary}>Go to login</Button>
        </Link>
      </div>
    );
  }

  if (!canUseCrm) {
    return (
      <div className={`${crm.page} flex-col items-center justify-center gap-4 p-4`}>
        <ShieldAlert className="h-12 w-12 text-red-500" />
        <h1 className="text-slate-900 text-xl font-bold">Access Denied</h1>
        <p className="text-slate-500 text-center max-w-md">
          Only the owner admin or CRM staff accounts can open this panel.
        </p>
        <Link href="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    );
  }

  const kpis = overviewQuery.data?.kpis;
  const readOnlyBanner = !crmAccess?.canEditUsers && !crmAccess?.canEditCredits;

  return (
    <div className={crm.page}>
      <aside className={crm.aside}>
        <div className="px-5 py-5 border-b border-slate-200 flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 flex items-center justify-center">
            <Eye className="h-5 w-5 text-white" />
          </div>
          <div>
            <div className="font-semibold tracking-tight text-slate-900">AuraEye Admin</div>
            <div className="text-xs text-slate-500">Simple control panel</div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {nav.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                className={`w-full flex items-center gap-3 rounded-xl px-3 py-3 text-left transition ${
                  active
                    ? "bg-indigo-50 text-indigo-800 border border-indigo-200"
                    : "text-slate-600 hover:bg-slate-50 border border-transparent"
                }`}
              >
                <Icon className="h-5 w-5 shrink-0" />
                <div>
                  <div className="text-sm font-medium">{item.label}</div>
                  <div className="text-[11px] text-slate-500">{item.hint}</div>
                </div>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200">
          <div className="rounded-2xl bg-slate-50 border border-slate-200 p-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-full bg-indigo-100 flex items-center justify-center text-sm font-semibold text-indigo-700">
              {(user.name || user.username || "A").slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">{user.name || user.username}</div>
              <div className="text-xs text-slate-500">{roleLabel(crmAccess?.role || "viewer")}</div>
            </div>
            <button type="button" onClick={() => logoutMutation.mutate()} className="text-slate-400 hover:text-slate-700" title="Log out">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex-1 min-h-0 min-w-0 flex flex-col w-full">
        <header className={crm.header}>
          <div className="px-4 md:px-6 py-3 md:py-4 flex items-start gap-3 justify-between">
            <div className="min-w-0 flex-1">
              <div className="lg:hidden flex items-center gap-2 mb-2">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-indigo-500 to-fuchsia-500 flex items-center justify-center shrink-0">
                  <Eye className="h-4 w-4 text-white" />
                </div>
                <span className="font-semibold text-slate-900 text-sm">AuraEye Admin</span>
              </div>
              <h1 className="text-lg md:text-2xl font-semibold text-slate-900 truncate">
                {section === "home" && `Hello, ${user.name || user.username}`}
                {section === "people" && "People & accounts"}
                {section === "money" && "Money & payments"}
                {section === "inbox" && "Messages & leads"}
                {section === "team" && "Team access"}
                {section === "insights" && "Insights & daily logs"}
                {section === "audit" && "Activity log"}
              </h1>
              <p className="text-xs md:text-sm text-slate-500 line-clamp-2">
                {readOnlyBanner
                  ? "View-only mode — you can look but not change things."
                  : "Everything you need is in the menu below. No technical skills required."}
              </p>
            </div>
            <div className="flex flex-col items-end gap-2 shrink-0">
              <button
                type="button"
                onClick={() => logoutMutation.mutate()}
                className="lg:hidden rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50"
                title="Log out"
              >
                <LogOut className="h-4 w-4" />
              </button>
              {(crmAccess?.canEditUsers || crmAccess?.canManageTickets) && (
                <Button
                  size="sm"
                  className={`md:hidden ${crm.btnPrimary}`}
                  onClick={() => setQuickActionOpen(true)}
                >
                  + Action
                </Button>
              )}
              <div className="hidden md:flex flex-wrap items-center gap-2">
                {readOnlyBanner && (
                  <div className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 inline-flex items-center gap-1">
                    <Lock className="h-3 w-3" /> View only
                  </div>
                )}
                {(crmAccess?.canEditUsers || crmAccess?.canManageTickets) && (
                  <Button size="sm" className={crm.btnPrimary} onClick={() => setQuickActionOpen(true)}>
                    + Quick action
                  </Button>
                )}
              </div>
            </div>
          </div>

          <div className="hidden lg:flex gap-2 overflow-x-auto px-4 pb-3">
            {nav.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs border ${
                  section === item.id ? crm.pillActive : crm.pillInactive
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </header>

        <main className={crm.main}>
          {section === "home" && (
            <>
              <HelpTip>
                <strong>Start here.</strong> Red numbers below need attention — click them to jump straight to the right
                list. Open tickets can be resolved without leaving this page.
              </HelpTip>

              <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
                {[
                  {
                    label: "Total users",
                    value: kpis?.totalUsers,
                    icon: Users,
                    tone: "text-sky-600",
                    action: () => goToPeople({ typeFilter: "client" }),
                  },
                  {
                    label: "Active users",
                    value: kpis?.activeUsers,
                    icon: Activity,
                    tone: "text-emerald-600",
                    action: () => goToPeople({ phaseFilter: "active", typeFilter: "client" }),
                  },
                  {
                    label: "Needs attention",
                    value: kpis?.atRiskUsers,
                    icon: AlertTriangle,
                    tone: "text-amber-600",
                    action: () => goToPeople({ phaseFilter: "at-risk", typeFilter: "client" }),
                  },
                  {
                    label: "Inactive (long quiet)",
                    value: kpis?.dormantUsers ?? kpis?.churnedUsers,
                    icon: FileWarning,
                    tone: "text-slate-600",
                    action: () => goToPeople({ phaseFilter: "dormant", typeFilter: "client" }),
                  },
                  {
                    label: "Healers",
                    value: kpis?.healers,
                    icon: HeartPulse,
                    tone: "text-fuchsia-600",
                    action: () => goToPeople({ typeFilter: "healer" }),
                  },
                ].map((card) => {
                  const Icon = card.icon;
                  return (
                    <button
                      key={card.label}
                      type="button"
                      onClick={card.action}
                      className="text-left rounded-xl border border-slate-200 bg-white shadow-sm p-4 hover:border-indigo-200 hover:bg-indigo-50/50 transition"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs text-slate-500">{card.label}</span>
                        <Icon className={`h-4 w-4 ${card.tone}`} />
                      </div>
                      <div className="text-2xl font-semibold text-slate-900">
                        {overviewQuery.isLoading ? "…" : (card.value ?? 0).toLocaleString()}
                      </div>
                      <div className="text-[10px] text-indigo-600 mt-2">Click to view →</div>
                    </button>
                  );
                })}
              </div>

              <div className="grid xl:grid-cols-3 gap-4">
                {crmAccess?.canManageTickets && (
                  <Card className={`${crm.card} xl:col-span-1`}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        <Ticket className="h-4 w-4 text-indigo-600" />
                        Open messages ({kpis?.openTickets ?? 0})
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {(ticketsPreviewQuery.data?.tickets || []).slice(0, 5).map((t: any) => (
                        <div key={t.id} className="rounded-lg border border-slate-200 p-2 text-xs">
                          <div className="font-medium truncate">{t.subject}</div>
                          <div className="flex gap-2 mt-2">
                            <Button
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => resolveTicketMutation.mutate(t.id)}
                            >
                              Resolve
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setSection("inbox")}>
                              See all
                            </Button>
                          </div>
                        </div>
                      ))}
                      {(ticketsPreviewQuery.data?.tickets || []).length === 0 && (
                        <p className="text-sm text-slate-500">No open tickets — you're all caught up!</p>
                      )}
                      <Button variant="outline" className="w-full" onClick={() => setSection("inbox")}>
                        Open full inbox
                      </Button>
                    </CardContent>
                  </Card>
                )}

                <Card className={crm.card}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Bell className="h-4 w-4 text-amber-600" />
                      Who to check on
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {(overviewQuery.data?.monthlyNotifications || []).map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        onClick={() => {
                          const map: Record<string, string> = {
                            inactive: "at-risk",
                            churned: "dormant",
                            dormant: "dormant",
                            new: "new",
                            "at-risk": "at-risk",
                          };
                          goToPeople({ phaseFilter: map[n.id] || "all", typeFilter: "client" });
                        }}
                        className="w-full text-left rounded-xl border border-slate-200 bg-slate-50 p-3 hover:bg-indigo-50 transition"
                      >
                        <div className="font-medium text-sm">{n.title}</div>
                        <p className="text-xs text-slate-500 mt-1">{n.detail}</p>
                      </button>
                    ))}
                  </CardContent>
                </Card>

                <Card className={crm.card}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">System health</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {(overviewQuery.data?.systemHealth || []).map((s) => (
                      <div key={s.name} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
                        <span>{s.name}</span>
                        <span className={s.status === "healthy" ? "text-emerald-600" : "text-amber-600"}>
                          {s.status === "healthy" ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                        </span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </div>

              <div className="grid xl:grid-cols-3 gap-4">
                <Card className={crm.card}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <BarChart3 className="h-4 w-4 text-indigo-600" /> Revenue (30 days)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-3xl font-semibold mb-1">
                      £{(kpis?.mrr ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </div>
                    {crmAccess?.canViewRevenue && (
                      <Button size="sm" variant="outline" className="mt-2" onClick={() => setSection("money")}>
                        Full money report →
                      </Button>
                    )}
                  </CardContent>
                </Card>

                {crmAccess?.canViewUsers && (
                  <Card className={crm.card}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-base flex items-center gap-2">
                        <LineChart className="h-4 w-4 text-indigo-600" /> Daily insights
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-slate-500 mb-3">
                        See what happened each day — sign-ups, visits, scans, and payments.
                      </p>
                      <Button size="sm" variant="outline" onClick={() => setSection("insights")}>
                        Open insights →
                      </Button>
                    </CardContent>
                  </Card>
                )}

                <Card className={crm.card}>
                  <CardContent className="space-y-2 text-sm">
                    {[
                      { label: "Aura scans", value: overviewQuery.data?.featureUsage?.auraScans },
                      { label: "Vibe checks", value: overviewQuery.data?.featureUsage?.vibeChecks },
                      { label: "Numerology", value: overviewQuery.data?.featureUsage?.numerology },
                      { label: "Object scans", value: overviewQuery.data?.featureUsage?.objectScans },
                    ].map((row) => (
                      <div key={row.label} className="flex justify-between rounded-lg bg-slate-50 px-3 py-2">
                        <span className="text-slate-600">{row.label}</span>
                        <span className="font-mono">{(row.value ?? 0).toLocaleString()}</span>
                      </div>
                    ))}
                  </CardContent>
                </Card>

                <Card className={crm.card}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">Journey stages</CardTitle>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 gap-2">
                    {Object.entries(overviewQuery.data?.phases || {}).map(([key, value]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => goToPeople({ phaseFilter: key, typeFilter: "client" })}
                        className="rounded-lg bg-slate-50 border border-slate-100 p-2 text-left hover:bg-indigo-50"
                      >
                        <div className="text-xs text-slate-500">{phaseLabel(key)}</div>
                        <div className="text-lg font-semibold">{(value as number).toLocaleString()}</div>
                      </button>
                    ))}
                  </CardContent>
                </Card>
              </div>

              {crmAccess?.canViewAudit && (
                <Card className={crm.card}>
                  <CardHeader className="pb-2 flex flex-row items-center justify-between">
                    <CardTitle className="text-base">Recent changes</CardTitle>
                    <Button size="sm" variant="outline" onClick={() => setSection("audit")}>
                      Full log
                    </Button>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {(auditQuery.data?.logs || []).slice(0, 5).map((log: any) => (
                      <div key={log.id} className="text-sm border-b border-slate-100 pb-2">
                        <span className="font-medium">{log.actorUsername}</span> {log.action}{" "}
                        <span className="text-slate-500">
                          {log.entityType} {log.entityId}
                        </span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              <Card className={crm.card}>
                <CardHeader className="pb-2">
                  <button
                    type="button"
                    className="text-base font-semibold flex items-center gap-2 w-full text-left"
                    onClick={() => setShowChecklist((v) => !v)}
                  >
                    <LayoutDashboard className="h-4 w-4 text-indigo-600" />
                    Feature checklist (from spec)
                    <span className="text-xs text-slate-500 ml-auto">{showChecklist ? "Hide" : "Show"}</span>
                  </button>
                </CardHeader>
                {showChecklist && (
                  <CardContent>
                    <div className="grid sm:grid-cols-2 gap-2 text-sm">
                      {CRM_CHECKLIST.map((item) => (
                        <div
                          key={item.id}
                          className={`flex items-start gap-2 rounded-lg px-3 py-2 ${
                            item.done ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"
                          }`}
                        >
                          <span>{item.done ? "✓" : "○"}</span>
                          <span>{item.label}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                )}
              </Card>
            </>
          )}

          {section === "people" && crmAccess && (
            <PeopleWorkspace
              crmAccess={crmAccess}
              initialUserId={peopleNav.userId}
              initialPhaseFilter={peopleNav.phaseFilter}
              initialTypeFilter={peopleNav.typeFilter}
              onOpenQuickAction={() => setQuickActionOpen(true)}
            />
          )}

          {section === "money" && crmAccess?.canViewRevenue && (
            <div className="space-y-4">
              <HelpTip>Payments, refunds, and credit expiry in one place. Use the entity filter for GBP vs INR.</HelpTip>
              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-sm text-slate-500">Show:</span>
                {["all", "gbp", "inr"].map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => setEntityFilter(e)}
                    className={`rounded-full px-3 py-1 text-xs border ${
                      entityFilter === e ? crm.pillActive : crm.pillInactive
                    }`}
                  >
                    {e === "all" ? "All currencies" : e.toUpperCase()}
                  </button>
                ))}
              </div>
              <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3">
                {[
                  { label: "Revenue", value: `£${(revenueQuery.data?.summary?.totalRevenue || 0).toLocaleString()}`, tone: "text-emerald-700" },
                  { label: "Refunds", value: `£${(revenueQuery.data?.summary?.totalRefunds || 0).toLocaleString()}`, tone: "text-rose-600" },
                  { label: "Credits expired", value: (revenueQuery.data?.summary?.expiredCredits || 0).toLocaleString(), tone: "text-amber-600" },
                  { label: "Expiring soon", value: (revenueQuery.data?.summary?.expiringSoonCount || 0).toLocaleString(), tone: "text-sky-600" },
                ].map((c) => (
                  <Card key={c.label} className={crm.card}>
                    <CardContent className="p-4">
                      <div className="text-xs text-slate-500 mb-1">{c.label}</div>
                      <div className={`text-xl font-semibold ${c.tone}`}>{c.value}</div>
                    </CardContent>
                  </Card>
                ))}
              </div>
              <Card className={crm.card}>
                <CardHeader className="pb-2 flex flex-row items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">Credit ledger health</CardTitle>
                    <p className="text-xs text-slate-500 mt-1">
                      Live check of every user balance, transaction chain, username, and grant record.
                    </p>
                  </div>
                  {crmAccess?.role === "owner" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={reconcileCreditsMutation.isPending}
                      onClick={() => {
                        if (
                          confirm(
                            "Reconcile every account while preserving each current balance? Existing credit usage amounts will be kept and any correction will be recorded.",
                          )
                        ) {
                          reconcileCreditsMutation.mutate();
                        }
                      }}
                    >
                      {reconcileCreditsMutation.isPending ? "Reconciling…" : "Reconcile all ledgers"}
                    </Button>
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
                    {[
                      ["Transactions", creditHealthQuery.data?.totalTransactions],
                      ["Credits issued", creditHealthQuery.data?.totalCreditsIssued],
                      ["Credits used", creditHealthQuery.data?.totalCreditsUsed],
                      ["Chain issues", creditHealthQuery.data?.chainMismatches],
                      ["Balance issues", creditHealthQuery.data?.balanceMismatches],
                      ["Negative balances", creditHealthQuery.data?.negativeBalances],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg bg-slate-50 border border-slate-100 p-2 text-center">
                        <div className="font-semibold text-base">{Number(value || 0).toLocaleString()}</div>
                        <div className="text-slate-500">{label}</div>
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                    {[
                      ["Username issues", creditHealthQuery.data?.usernameMismatches],
                      ["Grant issues", creditHealthQuery.data?.grantMismatches],
                      ["Users without ledger", creditHealthQuery.data?.usersWithoutLedger],
                      ["Service issues", creditHealthQuery.data?.serviceMismatches],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-lg border border-slate-100 px-3 py-2 flex justify-between">
                        <span className="text-slate-600">{label}</span>
                        <span className={Number(value || 0) ? "font-semibold text-amber-700" : "font-semibold text-emerald-700"}>
                          {Number(value || 0).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-slate-700">Service-cost audit</span>
                      <span className="text-xs text-slate-500">Current policy</span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
                      {[
                        ["Expected", creditHealthQuery.data?.totalServiceExpected],
                        ["Recorded", creditHealthQuery.data?.totalServiceRecorded],
                        [
                          "Difference",
                          Number(creditHealthQuery.data?.totalServiceRecorded || 0) -
                            Number(creditHealthQuery.data?.totalServiceExpected || 0),
                        ],
                        ["Numerology", 3],
                        ["Aura / Object / Vibe", "5 / 1 / 1"],
                      ].map(([label, value]) => (
                        <div key={label} className="rounded-lg bg-slate-50 border border-slate-100 p-2 text-center">
                          <div className="font-semibold text-base">
                            {typeof value === "number" ? value.toLocaleString() : value}
                          </div>
                          <div className="text-slate-500">{label}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 overflow-hidden">
                    <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-sm font-medium">
                      Accounts needing attention
                    </div>
                    <div className="max-h-64 overflow-auto">
                      <table className="w-full min-w-[900px] text-xs">
                        <thead className="sticky top-0 bg-white border-b border-slate-200 text-left text-slate-500">
                          <tr>
                            <th className="px-3 py-2">User</th>
                            <th className="px-3 py-2 text-right">Current</th>
                            <th className="px-3 py-2 text-right">Used</th>
                            <th className="px-3 py-2 text-right">Expected</th>
                            <th className="px-3 py-2 text-right">Recorded</th>
                            <th className="px-3 py-2 text-right">Transactions</th>
                            <th className="px-3 py-2">Issues</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(creditHealthQuery.data?.users || [])
                            .filter(
                              (u: any) =>
                                u.chainMismatches ||
                                u.usernameMismatches ||
                                u.grantMismatch ||
                                u.negativeBalance ||
                                u.serviceDifference ||
                                Object.values(u.serviceActivity || {}).some(
                                  (count: any, index: number) =>
                                    count !== Object.values(u.serviceTransactions || {})[index],
                                ) ||
                                (u.lastTransactionBalance !== null && u.lastTransactionBalance !== u.credits) ||
                                (u.transactionCount === 0 && u.credits !== 0),
                            )
                            .map((u: any) => (
                              <tr key={u.userId} className="border-b border-slate-100 last:border-0">
                                <td className="px-3 py-2">@{u.username}</td>
                                <td className={`px-3 py-2 text-right font-mono ${u.negativeBalance ? "text-rose-700 font-semibold" : ""}`}>
                                  {u.credits}
                                </td>
                                <td className="px-3 py-2 text-right font-mono">{u.creditsUsed}</td>
                                <td className="px-3 py-2 text-right font-mono">{u.serviceExpected}</td>
                                <td className="px-3 py-2 text-right font-mono">{u.serviceRecorded}</td>
                                <td className="px-3 py-2 text-right font-mono">{u.transactionCount}</td>
                                <td className="px-3 py-2 text-amber-700">
                                  {[
                                    u.chainMismatches ? `${u.chainMismatches} chain` : "",
                                    u.usernameMismatches ? `${u.usernameMismatches} username` : "",
                                    u.grantMismatch ? "grant" : "",
                                    u.negativeBalance ? "negative balance" : "",
                                    u.serviceDifference ? `service ${u.serviceDifference > 0 ? "+" : ""}${u.serviceDifference}` : "",
                                    u.lastTransactionBalance !== null && u.lastTransactionBalance !== u.credits ? "balance" : "",
                                  ]
                                    .filter(Boolean)
                                    .join(" · ") || "opening ledger"}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                      {(creditHealthQuery.data?.users || []).filter(
                        (u: any) =>
                          u.chainMismatches ||
                          u.usernameMismatches ||
                          u.grantMismatch ||
                          u.negativeBalance ||
                          u.serviceDifference ||
                          Object.values(u.serviceActivity || {}).some(
                            (count: any, index: number) =>
                              count !== Object.values(u.serviceTransactions || {})[index],
                          ) ||
                          (u.lastTransactionBalance !== null && u.lastTransactionBalance !== u.credits) ||
                          (u.transactionCount === 0 && u.credits !== 0),
                      ).length === 0 && <p className="p-4 text-sm text-emerald-700">All credit records agree.</p>}
                    </div>
                  </div>
                </CardContent>
              </Card>
              <div className="grid xl:grid-cols-2 gap-4">
                <Card className={crm.card}>
                  <CardHeader>
                    <CardTitle className="text-base">Refund log</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 max-h-72 overflow-y-auto">
                    {(revenueQuery.data?.refundLog || []).length === 0 && (
                      <p className="text-sm text-slate-500">No refunds yet.</p>
                    )}
                    {(revenueQuery.data?.refundLog || []).slice(0, 40).map((r: any, i: number) => (
                      <div key={`${r.kind}-${r.id}-${i}`} className="text-xs rounded-lg bg-slate-50 p-2 flex justify-between">
                        <div>
                          <div className="font-medium">{r.kind === "payment_refund" ? "Payment refund" : "Credit refund"}</div>
                          <div className="text-slate-500">User #{r.userId}</div>
                        </div>
                        <div className="font-mono text-rose-600">{r.amount}</div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
                <Card className={crm.card}>
                  <CardHeader>
                    <CardTitle className="text-base">Credit expiry log</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 max-h-72 overflow-y-auto">
                    {(revenueQuery.data?.expiryLog || []).slice(0, 40).map((r: any, i: number) => (
                      <div key={`exp-${r.id}-${i}`} className="text-xs rounded-lg bg-slate-50 p-2 flex justify-between">
                        <div>@{r.username || r.userId}</div>
                        <div className="font-mono text-amber-600">-{r.amount}</div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </div>
              <Card className={crm.card}>
                <CardHeader>
                  <CardTitle className="text-base">Recent payments</CardTitle>
                </CardHeader>
                <CardContent className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className={crm.tableHead}>
                        <th className="pb-2">User</th>
                        <th className="pb-2">Amount</th>
                        <th className="pb-2">Status</th>
                        <th className="pb-2">When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(revenueQuery.data?.payments || []).slice(0, 30).map((p: any) => (
                        <tr key={p.id} className="border-b border-slate-100">
                          <td className="py-2">{p.userId}</td>
                          <td className="py-2 font-mono">£{((p.amount || 0) / 100).toFixed(2)}</td>
                          <td className="py-2">{p.status}</td>
                          <td className="py-2 text-slate-500">{p.createdAt ? new Date(p.createdAt).toLocaleString() : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </div>
          )}

          {section === "inbox" && crmAccess && (
            <InboxWorkspace
              crmAccess={crmAccess}
              onSelectUser={(userId) => goToPeople({ userId })}
            />
          )}

          {section === "team" && crmAccess?.canManageStaff && (
            <div className="grid xl:grid-cols-3 gap-4">
              <Card className={crm.card}>
                <CardHeader>
                  <CardTitle className="text-base">Add staff login</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <HelpTip>
                    Create a username and password for someone to open /admin. <strong>Viewer</strong> = look only.{" "}
                    <strong>Editor</strong> = can change users and credits. <strong>Support</strong> = tickets.
                  </HelpTip>
                  <Input
                    value={staffForm.username}
                    onChange={(e) => setStaffForm({ ...staffForm, username: e.target.value })}
                    placeholder="Username"
                    className={crm.input}
                  />
                  <Input
                    type="password"
                    value={staffForm.password}
                    onChange={(e) => setStaffForm({ ...staffForm, password: e.target.value })}
                    placeholder="Password (min 6 characters)"
                    className={crm.input}
                  />
                  <Input
                    value={staffForm.displayName}
                    onChange={(e) => setStaffForm({ ...staffForm, displayName: e.target.value })}
                    placeholder="Their name (optional)"
                    className={crm.input}
                  />
                  <select
                    value={staffForm.role}
                    onChange={(e) => setStaffForm({ ...staffForm, role: e.target.value })}
                    className={crm.select}
                  >
                    <option value="viewer">Viewer — look only</option>
                    <option value="editor">Editor — edit users & credits</option>
                    <option value="support">Support — tickets + view users</option>
                    <option value="owner">Owner — everything</option>
                  </select>
                  <Button className={`w-full ${crm.btnPrimary}`} disabled={createStaffMutation.isPending} onClick={() => createStaffMutation.mutate()}>
                    Create login
                  </Button>
                </CardContent>
              </Card>
              <Card className={`${crm.card} xl:col-span-2`}>
                <CardHeader>
                  <CardTitle className="text-base">Staff accounts</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(staffQuery.data?.staff || []).map((s: any) => (
                    <div key={s.id} className="rounded-xl border border-slate-200 p-3 flex flex-wrap gap-3 justify-between items-center">
                      <div>
                        <div className="font-medium text-sm">
                          {s.displayName || s.name || s.username}{" "}
                          <span className="text-slate-500">@{s.username}</span>
                        </div>
                        <div className="text-xs text-slate-500">{roleLabel(s.role)}</div>
                      </div>
                      <div className="flex gap-2">
                        <select
                          value={s.role}
                          onChange={(e) => updateStaffMutation.mutate({ id: s.id, patch: { role: e.target.value } })}
                          className="rounded-md border border-slate-200 text-xs px-2 h-8"
                        >
                          <option value="viewer">viewer</option>
                          <option value="editor">editor</option>
                          <option value="support">support</option>
                          <option value="owner">owner</option>
                        </select>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => updateStaffMutation.mutate({ id: s.id, patch: { isActive: s.isActive === false } })}
                        >
                          {s.isActive === false ? "Enable" : "Disable"}
                        </Button>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          )}

          {section === "insights" && crmAccess && <InsightsWorkspace crmAccess={crmAccess} />}

          {section === "audit" && crmAccess?.canViewAudit && (
            <Card className={crm.card}>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Shield className="h-4 w-4 text-rose-600" /> Activity log
                </CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <div className="mb-4">
                  <HelpTip>Every change an admin makes is recorded here. Rollback restores a previous user snapshot.</HelpTip>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className={crm.tableHead}>
                      <th className="pb-2">When</th>
                      <th className="pb-2">Who</th>
                      <th className="pb-2">Action</th>
                      <th className="pb-2">What</th>
                      <th className="pb-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {(auditQuery.data?.logs || []).map((log: any) => (
                      <tr key={log.id} className="border-b border-slate-100">
                        <td className="py-2 text-slate-500">{log.createdAt ? new Date(log.createdAt).toLocaleString() : ""}</td>
                        <td className="py-2">{log.actorUsername}</td>
                        <td className="py-2">{log.action}</td>
                        <td className="py-2 text-slate-500">
                          {log.entityType} {log.entityId || ""}
                        </td>
                        <td className="py-2">
                          {crmAccess?.canEditUsers && log.action === "update" && log.entityType === "user" && log.previousValue && (
                            <Button size="sm" variant="outline" onClick={() => rollbackMutation.mutate(log.id)}>
                              Undo
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </main>

        <footer className="hidden lg:flex border-t border-slate-200 px-4 md:px-6 py-3 text-xs text-slate-500 flex-wrap justify-between gap-2 bg-white">
          <div className="flex flex-wrap gap-4">
            <span>Open tickets: {kpis?.openTickets ?? 0}</span>
            <span>Revenue (30d): £{(kpis?.mrr ?? 0).toLocaleString()}</span>
          </div>
          <div>AuraEye Admin · simple mode</div>
        </footer>

        <nav className={crm.bottomNav} aria-label="Admin navigation">
          <div className="flex overflow-x-auto">
            {nav.map((item) => {
              const Icon = item.icon;
              const active = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSection(item.id)}
                  className={`flex-1 min-w-[4.5rem] flex flex-col items-center gap-0.5 py-2 px-1 text-[10px] ${
                    active ? "text-indigo-700 bg-indigo-50" : "text-slate-500"
                  }`}
                >
                  <Icon className="h-5 w-5" />
                  <span className="truncate max-w-full">{item.label.split(" ")[0]}</span>
                </button>
              );
            })}
          </div>
        </nav>
      </div>

      <QuickActionDialog
        open={quickActionOpen}
        onClose={() => setQuickActionOpen(false)}
        canEditUsers={!!crmAccess?.canEditUsers}
        canEditCredits={!!crmAccess?.canEditCredits}
        canManageTickets={!!crmAccess?.canManageTickets}
        selectedUserId={peopleNav.userId}
      />
    </div>
  );
}
