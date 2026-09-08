import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Activity,
  ArrowLeft,
  CheckCircle2,
  CreditCard,
  Download,
  FileUp,
  Loader2,
  Lock,
  MessageSquare,
  Pencil,
  Search,
  Trash2,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { FileImportPanel } from "./FileImportPanel";
import { HelpTip, StepLabel } from "./HelpTip";
import { crm } from "./theme";
import { PHASE_LABELS, type CrmAccess, type CrmUserRow } from "./types";

type DetailTab = "activity" | "edit" | "credits" | "contract" | "messages";

function phaseBadge(phase: string) {
  const map: Record<string, string> = {
    new: "bg-sky-50 text-sky-700 border-sky-200",
    active: "bg-emerald-50 text-emerald-700 border-emerald-200",
    "at-risk": "bg-amber-50 text-amber-700 border-amber-200",
    dormant: "bg-slate-100 text-slate-600 border-slate-200",
    churned: "bg-slate-100 text-slate-600 border-slate-200",
  };
  return map[phase] || map.dormant;
}

function phaseLabel(phase: string, override?: string) {
  if (override) return override;
  if (phase === "churned") return PHASE_LABELS.dormant;
  return PHASE_LABELS[phase] || phase;
}

function timelineTone(type: string) {
  const map: Record<string, string> = {
    aura_scan: "border-l-indigo-400",
    vibe_check: "border-l-fuchsia-400",
    numerology: "border-l-amber-400",
    object_scan: "border-l-cyan-400",
    credit: "border-l-emerald-400",
    payment: "border-l-sky-400",
    journal: "border-l-rose-300",
    meditation: "border-l-violet-400",
    login: "border-l-slate-400",
  };
  return map[type] || "border-l-slate-300";
}

export default function PeopleWorkspace({
  crmAccess,
  initialUserId,
  initialPhaseFilter,
  initialTypeFilter,
  onOpenQuickAction,
}: {
  crmAccess: CrmAccess;
  initialUserId?: number | null;
  initialPhaseFilter?: string;
  initialTypeFilter?: string;
  onOpenQuickAction: () => void;
}) {
  const { toast } = useToast();
  const [userQuery, setUserQuery] = useState("");
  const [phaseFilter, setPhaseFilter] = useState(initialPhaseFilter || "all");
  const [userTypeFilter, setUserTypeFilter] = useState(initialTypeFilter || "all");
  const [selectedUserId, setSelectedUserId] = useState<number | null>(initialUserId ?? null);
  const [detailTab, setDetailTab] = useState<DetailTab>("activity");
  const [showCreate, setShowCreate] = useState(false);
  const [creditAmount, setCreditAmount] = useState("5");
  const [creditValidityDays, setCreditValidityDays] = useState("30");
  const [editForm, setEditForm] = useState({
    name: "",
    email: "",
    mobileNumber: "",
    userType: "client",
    isActive: true,
  });
  const [contractForm, setContractForm] = useState({
    licenceStatus: "unknown",
    contractStatus: "unsigned",
    startDate: "",
    endDate: "",
    renewalDate: "",
    notes: "",
  });
  const [createForm, setCreateForm] = useState({
    username: "",
    password: "",
    name: "",
    email: "",
    mobileNumber: "",
    userType: "client",
    credits: "10",
    creditValidityDays: "30",
    specialty: "",
  });
  const [ticketForm, setTicketForm] = useState({ subject: "", body: "", priority: "normal" });

  useEffect(() => {
    if (initialUserId) setSelectedUserId(initialUserId);
  }, [initialUserId]);
  useEffect(() => {
    if (initialPhaseFilter) setPhaseFilter(initialPhaseFilter);
  }, [initialPhaseFilter]);
  useEffect(() => {
    if (initialTypeFilter) setUserTypeFilter(initialTypeFilter);
  }, [initialTypeFilter]);

  const usersQuery = useQuery<{ users: CrmUserRow[] }>({
    queryKey: ["/api/crm/users", userQuery, phaseFilter, userTypeFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (userQuery) params.set("q", userQuery);
      if (phaseFilter !== "all") params.set("phase", phaseFilter);
      if (userTypeFilter !== "all") params.set("type", userTypeFilter);
      params.set("limit", "300");
      const res = await apiRequest("GET", `/api/crm/users?${params.toString()}`);
      return res.json();
    },
    enabled: !!crmAccess?.canViewUsers,
  });

  const profileQuery = useQuery<any>({
    queryKey: ["/api/crm/users", selectedUserId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/crm/users/${selectedUserId}`);
      return res.json();
    },
    enabled: !!crmAccess?.canViewUsers && !!selectedUserId,
    refetchInterval: selectedUserId ? 5000 : false,
  });

  const ticketsQuery = useQuery<{ tickets: any[] }>({
    queryKey: ["/api/crm/tickets", "by-user", selectedUserId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/crm/tickets?userId=${selectedUserId}`);
      return res.json();
    },
    enabled: !!crmAccess?.canManageTickets && !!selectedUserId,
  });

  useEffect(() => {
    if (profileQuery.data?.user) {
      const u = profileQuery.data.user;
      setEditForm({
        name: u.name || "",
        email: u.email || "",
        mobileNumber: u.mobileNumber || "",
        userType: u.userType || "client",
        isActive: u.isActive !== false,
      });
    }
    if (profileQuery.data?.contract) {
      const c = profileQuery.data.contract;
      setContractForm({
        licenceStatus: c.licenceStatus || "unknown",
        contractStatus: c.contractStatus || "unsigned",
        startDate: c.startDate || "",
        endDate: c.endDate || "",
        renewalDate: c.renewalDate || "",
        notes: c.notes || "",
      });
    }
  }, [profileQuery.data]);

  const updateUserMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/crm/users/${selectedUserId}`, editForm);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Saved", description: "Account details updated." });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/users", selectedUserId] });
    },
    onError: (err: any) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/crm/users/${selectedUserId}/reset-password`, { password: "healer123" });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Password reset", description: data.message });
    },
    onError: (err: any) => toast({ title: "Reset failed", description: err.message, variant: "destructive" }),
  });

  const creditMutation = useMutation({
    mutationFn: async (operation: "add" | "subtract" | "set") => {
      const res = await apiRequest("POST", `/api/crm/users/${selectedUserId}/credits`, {
        amount: creditAmount,
        operation,
        creditValidityDays: Number(creditValidityDays) || 30,
        description: `CRM ${operation}`,
      });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Credits updated", description: `New balance: ${data.creditsAfter}` });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/users", selectedUserId] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/overview"] });
    },
    onError: (err: any) => toast({ title: "Credit update failed", description: err.message, variant: "destructive" }),
  });

  const syncCreditsMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/crm/users/${selectedUserId}/sync-credits`);
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Credits synced",
        description: `Balance updated: ${data.creditsBefore} → ${data.creditsAfter}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/users", selectedUserId] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/overview"] });
    },
    onError: (err: any) => toast({ title: "Sync failed", description: err.message, variant: "destructive" }),
  });

  const contractMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", `/api/crm/healers/${selectedUserId}/contract`, contractForm);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Contract saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/users", selectedUserId] });
    },
    onError: (err: any) => toast({ title: "Contract failed", description: err.message, variant: "destructive" }),
  });

  const eraseMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/crm/users/${selectedUserId}/erase`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Account erased", description: "Personal data removed and account deactivated." });
      setSelectedUserId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/crm/users"] });
    },
    onError: (err: any) => toast({ title: "Erasure failed", description: err.message, variant: "destructive" }),
  });

  const createAccountMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/crm/users", {
        username: createForm.username.trim(),
        password: createForm.password,
        name: createForm.name || createForm.username,
        email: createForm.email || null,
        mobileNumber: createForm.mobileNumber || null,
        userType: createForm.userType,
        credits: Number(createForm.credits) || 0,
        creditValidityDays: Number(createForm.creditValidityDays) || 30,
        specialty: createForm.specialty || undefined,
      });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Account created", description: data.message });
      setShowCreate(false);
      if (data.user?.id) {
        setSelectedUserId(data.user.id);
        setDetailTab("edit");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/crm/users"] });
    },
    onError: (err: any) => toast({ title: "Create failed", description: err.message, variant: "destructive" }),
  });

  const createTicketMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/crm/tickets", { ...ticketForm, userId: selectedUserId });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Message logged" });
      setTicketForm({ subject: "", body: "", priority: "normal" });
      queryClient.invalidateQueries({ queryKey: ["/api/crm/tickets"] });
    },
    onError: (err: any) => toast({ title: "Failed", description: err.message, variant: "destructive" }),
  });

  const isHealer =
    profileQuery.data?.user?.userType === "healer" || profileQuery.data?.user?.userType === "semi-healer";

  const detailTabs: { id: DetailTab; label: string; icon: any }[] = [
    { id: "activity", label: "Activity", icon: Activity },
    { id: "edit", label: "Edit account", icon: Pencil },
    ...(crmAccess.canViewUsers ? [{ id: "credits" as DetailTab, label: "Credits & ledger", icon: CreditCard }] : []),
    ...(isHealer && crmAccess.canManageHealers
      ? [{ id: "contract" as DetailTab, label: "Healer paperwork", icon: FileUp }]
      : []),
    ...(crmAccess.canManageTickets
      ? [{ id: "messages" as DetailTab, label: "Messages", icon: MessageSquare }]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div className={crm.sectionBanner}>
        <h2 className="text-lg font-semibold text-indigo-900">People & accounts</h2>
        <p className={crm.help + " mt-1 text-indigo-800/80"}>
          Everything about clients and healers lives on this one screen. Pick someone on the left — view activity, edit
          details, change credits, and reset passwords without switching pages.
        </p>
      </div>

      <HelpTip>
        <strong>How to use:</strong> Step 1 — search or filter the list. Step 2 — click a name. Step 3 — use the tabs on
        the right (Activity, Edit, Credits, etc.).
      </HelpTip>

      <div className="flex flex-wrap gap-2 items-center">
        {crmAccess.canEditUsers && (
          <>
            <Button size="sm" className={crm.btnPrimary} onClick={() => setShowCreate((v) => !v)}>
              <UserPlus className="h-4 w-4 mr-1" />
              {showCreate ? "Hide create form" : "Create new account"}
            </Button>
            <Button size="sm" variant="outline" onClick={onOpenQuickAction}>
              Quick actions
            </Button>
          </>
        )}
        {crmAccess.canExportData && (
          <a href="/api/crm/users.csv">
            <Button size="sm" variant="outline">
              <Download className="h-4 w-4 mr-1" /> Download all as CSV
            </Button>
          </a>
        )}
      </div>

      {showCreate && crmAccess.canEditUsers && (
        <Card className={crm.card}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Create a new login</CardTitle>
          </CardHeader>
          <CardContent className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
            <Input
              placeholder="Username (required)"
              value={createForm.username}
              onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
              className={crm.input}
            />
            <Input
              type="password"
              placeholder="Password (required)"
              value={createForm.password}
              onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
              className={crm.input}
            />
            <Input
              placeholder="Display name"
              value={createForm.name}
              onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
              className={crm.input}
            />
            <Input
              placeholder="Email"
              value={createForm.email}
              onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
              className={crm.input}
            />
            <select
              value={createForm.userType}
              onChange={(e) => setCreateForm({ ...createForm, userType: e.target.value })}
              className={crm.select}
            >
              <option value="client">Client (app user)</option>
              <option value="healer">Healer</option>
              <option value="semi-healer">Semi-healer</option>
            </select>
            <Input
              type="number"
              placeholder="Starting credits"
              value={createForm.credits}
              onChange={(e) => setCreateForm({ ...createForm, credits: e.target.value })}
              className={crm.input}
            />
            <select
              value={createForm.creditValidityDays}
              onChange={(e) => setCreateForm({ ...createForm, creditValidityDays: e.target.value })}
              className={crm.select}
            >
              <option value="3">Credits last: 3 days</option>
              <option value="30">Credits last: 1 month</option>
              <option value="60">Credits last: 2 months</option>
              <option value="90">Credits last: 3 months</option>
              <option value="180">Credits last: 6 months</option>
            </select>
            {createForm.userType !== "client" && (
              <Input
                placeholder="Specialty (healers)"
                value={createForm.specialty}
                onChange={(e) => setCreateForm({ ...createForm, specialty: e.target.value })}
                className={crm.input}
              />
            )}
            <Button
              className={crm.btnPrimary + " sm:col-span-2"}
              disabled={createAccountMutation.isPending}
              onClick={() => createAccountMutation.mutate()}
            >
              {createAccountMutation.isPending ? "Creating…" : "Create account"}
            </Button>
          </CardContent>
        </Card>
      )}

      {crmAccess.canEditUsers && (
        <FileImportPanel target="users" disabled={!crmAccess.canEditUsers} />
      )}

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-4 min-w-0">
        <Card className={`${crm.card} xl:col-span-2 ${selectedUserId ? "hidden xl:block" : ""}`}>
          <CardHeader className="pb-2 space-y-3">
            <StepLabel n={1}>Find someone</StepLabel>
            <div className="relative">
              <Search className="h-4 w-4 absolute left-2.5 top-2.5 text-slate-400" />
              <Input
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
                placeholder="Search name, email, username…"
                className={`pl-8 ${crm.input}`}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <select
                value={userTypeFilter}
                onChange={(e) => setUserTypeFilter(e.target.value)}
                className="rounded-md border border-slate-200 text-sm px-2 py-1.5 bg-white"
              >
                <option value="all">Everyone</option>
                <option value="client">Clients only</option>
                <option value="healer">Healers only</option>
                <option value="semi-healer">Semi-healers</option>
              </select>
              <select
                value={phaseFilter}
                onChange={(e) => setPhaseFilter(e.target.value)}
                className="rounded-md border border-slate-200 text-sm px-2 py-1.5 bg-white"
              >
                <option value="all">All journey stages</option>
                <option value="new">{PHASE_LABELS.new}</option>
                <option value="active">{PHASE_LABELS.active}</option>
                <option value="at-risk">{PHASE_LABELS["at-risk"]}</option>
                <option value="dormant">{PHASE_LABELS.dormant}</option>
              </select>
            </div>
          </CardHeader>
          <CardContent>
            {usersQuery.isLoading ? (
              <div className="py-12 flex justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-indigo-600" />
              </div>
            ) : (
              <div className="max-h-[32rem] overflow-y-auto space-y-1">
                {(usersQuery.data?.users || []).map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => {
                      setSelectedUserId(u.id);
                      setDetailTab("activity");
                    }}
                    className={`w-full text-left rounded-xl px-3 py-2.5 border transition ${
                      selectedUserId === u.id
                        ? "border-indigo-300 bg-indigo-50"
                        : "border-transparent hover:bg-slate-50"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium truncate">{u.name || u.username}</div>
                        <div className="text-xs text-slate-500 truncate">{u.email || u.username}</div>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full border shrink-0 ${phaseBadge(u.phase)}`}>
                        {phaseLabel(u.phase, u.phaseLabel)}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 mt-1 flex gap-3">
                      <span>{u.userType}</span>
                      <span className="font-mono text-emerald-700">{u.credits} credits</span>
                    </div>
                  </button>
                ))}
                {(usersQuery.data?.users || []).length === 0 && (
                  <p className="text-sm text-slate-500 py-8 text-center">No one matches your search.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className={`${crm.card} xl:col-span-3 ${!selectedUserId ? "hidden xl:block" : ""}`}>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              {selectedUserId && (
                <button
                  type="button"
                  className="xl:hidden rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-50 shrink-0"
                  onClick={() => setSelectedUserId(null)}
                  aria-label="Back to list"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
              )}
              <StepLabel n={2}>View & manage</StepLabel>
            </div>
          </CardHeader>
          <CardContent>
            {!selectedUserId && (
              <div className="py-16 text-center px-4">
                <p className="text-slate-600 font-medium">Click a person on the left</p>
                <p className="text-sm text-slate-500 mt-2 max-w-sm mx-auto">
                  Their full profile, activity history, credits, and messages will appear here. You never need to open
                  another tab.
                </p>
              </div>
            )}
            {selectedUserId && profileQuery.isLoading && (
              <div className="py-12 flex justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-indigo-600" />
              </div>
            )}
            {selectedUserId && profileQuery.data && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                  <div>
                    <div className="text-lg font-semibold">
                      {profileQuery.data.user.name || profileQuery.data.user.username}
                    </div>
                    <div className="text-xs text-slate-500">
                      @{profileQuery.data.user.username} · {profileQuery.data.user.userType} ·{" "}
                      {profileQuery.data.user.credits} credits
                    </div>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded-full border ${phaseBadge(profileQuery.data.user.phase)}`}>
                    {phaseLabel(profileQuery.data.user.phase, profileQuery.data.user.phaseLabel)}
                  </span>
                </div>

                <div className="flex flex-wrap gap-1">
                  {detailTabs.map((t) => {
                    const Icon = t.icon;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setDetailTab(t.id)}
                        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs border ${
                          detailTab === t.id ? crm.pillActive : crm.pillInactive
                        }`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {t.label}
                      </button>
                    );
                  })}
                </div>

                {detailTab === "activity" && (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                      {[
                        { label: "Aura scans", n: profileQuery.data.activity?.auraReadings?.length },
                        { label: "Vibe checks", n: profileQuery.data.activity?.vibeReadings?.length },
                        { label: "Numerology", n: profileQuery.data.activity?.numerologyReadings?.length },
                        { label: "Object scans", n: profileQuery.data.activity?.objectAnalyses?.length },
                        { label: "Journals", n: profileQuery.data.activity?.journals },
                        { label: "Meditations", n: profileQuery.data.activity?.meditations },
                        { label: "Logins", n: profileQuery.data.activity?.logins },
                        { label: "Payments", n: profileQuery.data.payments?.length },
                      ].map((s) => (
                        <div key={s.label} className="rounded-lg bg-slate-50 border border-slate-100 p-2 text-center">
                          <div className="font-semibold text-base">{s.n ?? 0}</div>
                          <div className="text-slate-500">{s.label}</div>
                        </div>
                      ))}
                    </div>
                    {(profileQuery.data.creditGrants || []).length > 0 && (
                      <div className="rounded-xl border border-slate-200 p-3 space-y-2">
                        <div className="text-sm font-medium">Credit expiry</div>
                        {(profileQuery.data.creditGrants || []).map((g: any) => (
                          <div key={g.id} className="text-xs flex justify-between bg-slate-50 rounded px-2 py-1.5">
                            <span>
                              {g.remaining}/{g.amount} left
                            </span>
                            <span className="text-slate-500">
                              {g.expiresAt ? `expires ${new Date(g.expiresAt).toLocaleDateString()}` : "no expiry"}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div>
                      <div className="text-sm font-medium mb-2">Full activity timeline</div>
                      <div className="max-h-64 overflow-y-auto space-y-2">
                        {(profileQuery.data.timeline || []).slice(0, 50).map((ev: any, idx: number) => (
                          <div
                            key={`${ev.type}-${idx}`}
                            className={`rounded-lg bg-slate-50 border-l-2 pl-3 py-2 ${timelineTone(ev.type)}`}
                          >
                            <div className="text-xs font-medium">{ev.title}</div>
                            <div className="text-[10px] text-slate-500">
                              {ev.at ? new Date(ev.at).toLocaleString() : ""}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {detailTab === "edit" && (
                  <div className="space-y-3">
                    {!crmAccess.canEditUsers ? (
                      <p className="text-sm text-slate-500">You can view but not edit accounts.</p>
                    ) : (
                      <>
                        <HelpTip>Change name, email, or account type here. Click Save when done.</HelpTip>
                        <Input
                          value={editForm.name}
                          onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                          placeholder="Display name"
                          className={crm.input}
                        />
                        <Input
                          value={editForm.email}
                          onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                          placeholder="Email"
                          className={crm.input}
                        />
                        <Input
                          value={editForm.mobileNumber}
                          onChange={(e) => setEditForm({ ...editForm, mobileNumber: e.target.value })}
                          placeholder="Mobile number"
                          className={crm.input}
                        />
                        <select
                          value={editForm.userType}
                          onChange={(e) => setEditForm({ ...editForm, userType: e.target.value })}
                          className={crm.select}
                        >
                          <option value="client">Client</option>
                          <option value="healer">Healer</option>
                          <option value="semi-healer">Semi-healer</option>
                        </select>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={editForm.isActive}
                            onChange={(e) => setEditForm({ ...editForm, isActive: e.target.checked })}
                          />
                          Account is active (can log in)
                        </label>
                        <Button className={`w-full ${crm.btnPrimary}`} onClick={() => updateUserMutation.mutate()}>
                          Save changes
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full border-amber-300 text-amber-800 hover:bg-amber-50"
                          disabled={resetPasswordMutation.isPending}
                          onClick={() => {
                            const name =
                              profileQuery.data?.user?.name || profileQuery.data?.user?.username || "this user";
                            if (!confirm(`Set password for ${name} to healer123?`)) return;
                            resetPasswordMutation.mutate();
                          }}
                        >
                          <Lock className="h-4 w-4 mr-1" />
                          Reset password to healer123
                        </Button>
                        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100">
                          {crmAccess.canExportData && (
                            <a href={`/api/crm/users/${selectedUserId}/export`} target="_blank" rel="noreferrer">
                              <Button variant="outline" className="w-full">
                                <Download className="h-4 w-4 mr-1" /> GDPR export
                              </Button>
                            </a>
                          )}
                          {crmAccess.canEraseUsers && (
                            <Button
                              variant="destructive"
                              className="w-full"
                              onClick={() => {
                                if (confirm("Erase personal data and deactivate this account?")) eraseMutation.mutate();
                              }}
                            >
                              <Trash2 className="h-4 w-4 mr-1" /> Erase data
                            </Button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {detailTab === "credits" && crmAccess.canViewUsers && (
                  <div className="space-y-3">
                    {(() => {
                      const summary = profileQuery.data.creditSummary || {};
                      const uncharged = Object.values(summary.unchargedUsage || {}).reduce(
                        (sum: number, value: any) => sum + Number(value || 0),
                        0,
                      );
                      return (
                        <>
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                            {[
                              ["Current balance", summary.currentBalance ?? profileQuery.data.user.credits ?? 0],
                              ["Transactions", summary.transactionCount ?? profileQuery.data.credits?.length ?? 0],
                              ["Credits issued", summary.creditsIssued ?? 0],
                              ["Credits used", summary.creditsUsed ?? 0],
                            ].map(([label, value]) => (
                              <div key={label} className="rounded-lg bg-slate-50 border border-slate-100 p-2 text-center">
                                <div className="font-semibold text-base">{Number(value).toLocaleString()}</div>
                                <div className="text-slate-500">{label}</div>
                              </div>
                            ))}
                          </div>
                          <div
                            className={`rounded-lg border px-3 py-2 text-xs ${
                              summary.negativeBalance || summary.balanceDiscrepancy || uncharged
                                ? "border-amber-200 bg-amber-50 text-amber-800"
                                : "border-emerald-200 bg-emerald-50 text-emerald-800"
                            }`}
                          >
                            {summary.negativeBalance ? (
                              <span className="inline-flex items-center gap-1 text-rose-700 font-semibold">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                Negative balance: {summary.currentBalance} credits
                              </span>
                            ) : summary.balanceDiscrepancy || uncharged ? (
                              <span className="inline-flex items-center gap-1">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                {summary.balanceDiscrepancy
                                  ? `Balance differs from the latest transaction by ${summary.balanceDiscrepancy}.`
                                  : `${uncharged} recorded service use item(s) have no matching credit transaction.`}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1">
                                <CheckCircle2 className="h-3.5 w-3.5" /> Ledger balance and recorded usage agree.
                              </span>
                            )}
                          </div>
                          {crmAccess.canEditCredits && (
                            <>
                              <HelpTip>
                                Enter how many credits to add, subtract, or set. Every change is recorded in the ledger.
                              </HelpTip>
                              <Input
                                type="number"
                                value={creditAmount}
                                onChange={(e) => setCreditAmount(e.target.value)}
                                placeholder="Number of credits"
                                className={crm.input}
                              />
                              <select
                                value={creditValidityDays}
                                onChange={(e) => setCreditValidityDays(e.target.value)}
                                className={crm.select}
                              >
                                <option value="3">Valid for 3 days</option>
                                <option value="30">Valid for 1 month</option>
                                <option value="60">Valid for 2 months</option>
                                <option value="90">Valid for 3 months</option>
                                <option value="180">Valid for 6 months</option>
                              </select>
                              <div className="grid grid-cols-3 gap-2">
                                <Button variant="outline" onClick={() => creditMutation.mutate("add")}>
                                  Add
                                </Button>
                                <Button variant="outline" onClick={() => creditMutation.mutate("subtract")}>
                                  Remove
                                </Button>
                                <Button variant="outline" onClick={() => creditMutation.mutate("set")}>
                                  Set exact
                                </Button>
                              </div>
                              <Button
                                variant="outline"
                                className="w-full text-xs"
                                disabled={syncCreditsMutation.isPending}
                                onClick={() => syncCreditsMutation.mutate()}
                              >
                                Sync balance from grants
                              </Button>
                            </>
                          )}
                          <div className="rounded-xl border border-slate-200 overflow-hidden">
                            <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-sm font-medium">
                              Complete credit usage & transaction history
                            </div>
                            <div className="max-h-[32rem] overflow-auto">
                              <table className="w-full min-w-[720px] text-xs">
                                <thead className="sticky top-0 bg-white border-b border-slate-200 text-left text-slate-500">
                                  <tr>
                                    <th className="px-3 py-2">Date</th>
                                    <th className="px-3 py-2">Type</th>
                                    <th className="px-3 py-2">Description</th>
                                    <th className="px-3 py-2 text-right">Change</th>
                                    <th className="px-3 py-2 text-right">Balance after</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {(profileQuery.data.credits || []).map((transaction: any) => (
                                    <tr key={transaction.id} className="border-b border-slate-100 last:border-0">
                                      <td className="px-3 py-2 whitespace-nowrap">
                                        {transaction.createdAt ? new Date(transaction.createdAt).toLocaleString() : "—"}
                                      </td>
                                      <td className="px-3 py-2 whitespace-nowrap">{transaction.transactionType}</td>
                                      <td className="px-3 py-2 min-w-[260px]">{transaction.description}</td>
                                      <td
                                        className={`px-3 py-2 text-right font-mono ${
                                          transaction.amount < 0 ? "text-rose-600" : "text-emerald-700"
                                        }`}
                                      >
                                        {transaction.amount > 0 ? "+" : ""}
                                        {transaction.amount}
                                      </td>
                                      <td className="px-3 py-2 text-right font-mono">{transaction.balanceAfter}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              {(profileQuery.data.credits || []).length === 0 && (
                                <p className="p-4 text-sm text-slate-500">No credit transactions recorded yet.</p>
                              )}
                            </div>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}

                {detailTab === "contract" && isHealer && crmAccess.canManageHealers && (
                  <div className="space-y-3">
                    <HelpTip>Track licence and contract status for this healer/practitioner.</HelpTip>
                    <select
                      value={contractForm.licenceStatus}
                      onChange={(e) => setContractForm({ ...contractForm, licenceStatus: e.target.value })}
                      className={crm.select}
                    >
                      <option value="unknown">Licence: unknown</option>
                      <option value="valid">Licence: valid</option>
                      <option value="expired">Licence: expired</option>
                      <option value="pending">Licence: pending</option>
                    </select>
                    <select
                      value={contractForm.contractStatus}
                      onChange={(e) => setContractForm({ ...contractForm, contractStatus: e.target.value })}
                      className={crm.select}
                    >
                      <option value="unsigned">Contract: not signed</option>
                      <option value="signed">Contract: signed</option>
                      <option value="expired">Contract: expired</option>
                    </select>
                    <Input
                      value={contractForm.notes}
                      onChange={(e) => setContractForm({ ...contractForm, notes: e.target.value })}
                      placeholder="Notes"
                      className={crm.input}
                    />
                    <Button className={`w-full ${crm.btnPrimary}`} onClick={() => contractMutation.mutate()}>
                      Save paperwork
                    </Button>
                  </div>
                )}

                {detailTab === "messages" && crmAccess.canManageTickets && (
                  <div className="space-y-3">
                    <HelpTip>Support messages from the app, contact forms, and feedback appear here and in Messages & leads.</HelpTip>
                    {(ticketsQuery.data?.tickets || []).map((t: any) => (
                      <div key={t.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                        <div className="font-medium">{t.subject}</div>
                        <div className="text-xs text-slate-500 mt-1">
                          {t.status} · {t.channel} · {t.createdAt ? new Date(t.createdAt).toLocaleDateString() : ""}
                        </div>
                        <p className="text-xs text-slate-600 mt-2 whitespace-pre-wrap">{t.body}</p>
                      </div>
                    ))}
                    {(ticketsQuery.data?.tickets || []).length === 0 && (
                      <p className="text-sm text-slate-500">No messages for this person yet.</p>
                    )}
                    <div className="border-t border-slate-100 pt-3 space-y-2">
                      <div className="text-sm font-medium">Log a new message</div>
                      <Input
                        value={ticketForm.subject}
                        onChange={(e) => setTicketForm({ ...ticketForm, subject: e.target.value })}
                        placeholder="Subject"
                        className={crm.input}
                      />
                      <textarea
                        value={ticketForm.body}
                        onChange={(e) => setTicketForm({ ...ticketForm, body: e.target.value })}
                        placeholder="Details"
                        className={crm.textarea + " min-h-[80px]"}
                      />
                      <Button className={crm.btnPrimary} onClick={() => createTicketMutation.mutate()}>
                        Save message
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
