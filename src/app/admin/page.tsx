"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Users,
  Database,
  FileSpreadsheet,
  RefreshCcw,
  Loader2,
  AlertCircle,
  UserCheck,
  Laptop,
  CheckCircle2,
  X,
  RefreshCw,
  Cloud,
} from "lucide-react";
import { Button } from "@/components/ui/button";

// Match the interface with your optimized Stats API
interface DashboardStats {
  total: number;
  pendingSync: number;
  pendingLocalSync: number;
  checkedIn: number;
  timestamp?: string;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<DashboardStats>({
    total: 0,
    pendingSync: 0,
    pendingLocalSync: 0,
    checkedIn: 0,
  });

  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isExporting, setIsExporting] = useState<"csv" | "sql" | null>(null);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Auto-dismiss messages after 5 seconds
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  // 1. PURE DATA FETCHING (No sync UI state updates here to prevent linter errors)
  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/stats");
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      if (data.success) {
        setStats({
          total: data.total,
          pendingSync: data.pendingSync,
          pendingLocalSync: data.pendingLocalSync,
          checkedIn: data.checkedIn,
          timestamp: data.timestamp,
        });
      }
    } catch (error) {
      console.error("Failed to fetch stats:", error);
      throw error; // Throw to allow caller to handle UI error states
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 2. INITIAL LOAD (Wrapped in async function to satisfy React/ESLint rules)
  useEffect(() => {
    const loadInitialData = async () => {
      try {
        await fetchStats();
      } catch (e) {
        // Initial load error handled silently or via global error boundary
      }
    };
    loadInitialData();
  }, [fetchStats]);

  // 3. MANUAL REFRESH HANDLER (Handles UI spinners safely outside of useEffect)
  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    setMessage(null);
    try {
      await fetchStats();
    } catch (error) {
      setMessage({ text: "Failed to refresh statistics.", type: "error" });
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleSync = async () => {
    setIsSyncing(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/sync", { method: "POST" });
      const data = await res.json();

      if (res.ok && data.success) {
        setMessage({ text: data.message || "Google Sheets synced successfully!", type: "success" });
        await fetchStats(); // Instantly update numbers
      } else {
        setMessage({ text: data.message || "Sync failed", type: "error" });
      }
    } catch (error) {
      setMessage({ text: "Network error during sync", type: "error" });
    } finally {
      setIsSyncing(false);
    }
  };

  const handleExport = async (format: "csv" | "sql") => {
    setIsExporting(format);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/export?format=${format}`);
      if (!res.ok) throw new Error("Export failed");

      // Handle large file downloads cleanly
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `TDEUP_Database_Export_${new Date().toISOString().split("T")[0]}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

      setMessage({ text: `Successfully exported ${format.toUpperCase()} file.`, type: "success" });
    } catch (error) {
      setMessage({ text: `Failed to download ${format.toUpperCase()} export.`, type: "error" });
    } finally {
      setIsExporting(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50/50 p-4 sm:p-6 md:p-10 font-sans selection:bg-blue-100">
      <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
        {/* Header Section */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
          <div>
            <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight">
              Admin Control Center
            </h1>
            <p className="text-slate-500 mt-1.5 font-medium">
              Monitor live registrations, track check-ins, and manage offline data sync.
            </p>
          </div>
          <Button
            onClick={handleManualRefresh}
            variant="outline"
            disabled={isRefreshing || isLoading}
            className="shrink-0 h-11 bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200 rounded-xl font-semibold shadow-sm transition-all"
          >
            <RefreshCw
              className={`w-4 h-4 mr-2 ${isRefreshing ? "animate-spin text-blue-600" : ""}`}
            />
            {isRefreshing ? "Refreshing..." : "Refresh Data"}
          </Button>
        </div>

        {/* Global Alert Messages */}
        {message && (
          <div
            className={`p-4 rounded-xl flex items-start sm:items-center justify-between gap-3 border shadow-sm animate-in fade-in slide-in-from-top-2 duration-300 ${
              message.type === "success"
                ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                : "bg-red-50 border-red-200 text-red-800"
            }`}
          >
            <div className="flex items-center gap-3 font-semibold text-sm">
              {message.type === "success" ? (
                <CheckCircle2 className="w-5 h-5 shrink-0" />
              ) : (
                <AlertCircle className="w-5 h-5 shrink-0" />
              )}
              <p>{message.text}</p>
            </div>
            <button
              onClick={() => setMessage(null)}
              className="p-1 hover:bg-black/5 rounded-lg transition-colors shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* 4-Metric Stats Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
          {/* Stat 1: Total */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow group">
            <div className="flex items-start justify-between">
              <div className="p-3 bg-blue-50 text-blue-600 rounded-xl group-hover:scale-110 transition-transform">
                <Users className="w-6 h-6" />
              </div>
            </div>
            <div className="mt-4">
              <h2 className="text-4xl font-black text-slate-900 tracking-tight">
                {isLoading ? (
                  <Loader2 className="w-8 h-8 animate-spin text-slate-300" />
                ) : (
                  stats.total
                )}
              </h2>
              <p className="text-xs sm:text-sm font-bold text-slate-500 uppercase tracking-wider mt-1">
                Total Registered
              </p>
            </div>
          </div>

          {/* Stat 2: Checked In */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow group">
            <div className="flex items-start justify-between">
              <div className="p-3 bg-emerald-50 text-emerald-600 rounded-xl group-hover:scale-110 transition-transform">
                <UserCheck className="w-6 h-6" />
              </div>
            </div>
            <div className="mt-4">
              <h2 className="text-4xl font-black text-slate-900 tracking-tight">
                {isLoading ? (
                  <Loader2 className="w-8 h-8 animate-spin text-slate-300" />
                ) : (
                  stats.checkedIn
                )}
              </h2>
              <p className="text-xs sm:text-sm font-bold text-slate-500 uppercase tracking-wider mt-1">
                Total Checked-In
              </p>
            </div>
          </div>

          {/* Stat 3: Pending Cloud Sync */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow group relative overflow-hidden">
            {stats.pendingSync > 0 && (
              <div className="absolute top-0 right-0 w-2 h-full bg-amber-400 animate-pulse" />
            )}
            <div className="flex items-start justify-between">
              <div className="p-3 bg-amber-50 text-amber-600 rounded-xl group-hover:scale-110 transition-transform">
                <Cloud className="w-6 h-6" />
              </div>
            </div>
            <div className="mt-4">
              <h2 className="text-4xl font-black text-slate-900 tracking-tight">
                {isLoading ? (
                  <Loader2 className="w-8 h-8 animate-spin text-slate-300" />
                ) : (
                  stats.pendingSync
                )}
              </h2>
              <p className="text-xs sm:text-sm font-bold text-slate-500 uppercase tracking-wider mt-1">
                Pending Sheets Sync
              </p>
            </div>
          </div>

          {/* Stat 4: Pending Local Sync */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow group relative overflow-hidden">
            {stats.pendingLocalSync > 0 && (
              <div className="absolute top-0 right-0 w-2 h-full bg-indigo-500 animate-pulse" />
            )}
            <div className="flex items-start justify-between">
              <div className="p-3 bg-indigo-50 text-indigo-600 rounded-xl group-hover:scale-110 transition-transform">
                <Laptop className="w-6 h-6" />
              </div>
            </div>
            <div className="mt-4">
              <h2 className="text-4xl font-black text-slate-900 tracking-tight">
                {isLoading ? (
                  <Loader2 className="w-8 h-8 animate-spin text-slate-300" />
                ) : (
                  stats.pendingLocalSync
                )}
              </h2>
              <p className="text-xs sm:text-sm font-bold text-slate-500 uppercase tracking-wider mt-1">
                Pending Local Sync
              </p>
            </div>
          </div>
        </div>

        {/* Actions Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Cloud Operations */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
            <div className="p-5 sm:p-6 border-b border-slate-100 bg-amber-50/30 flex items-center gap-3">
              <Cloud className="w-5 h-5 text-amber-600" />
              <h3 className="font-bold text-lg text-slate-800">Cloud Operations</h3>
            </div>
            <div className="p-5 sm:p-6 flex-1 flex flex-col justify-center">
              <p className="text-sm text-slate-500 font-medium mb-5">
                Manually push pending data to Google Sheets. The automated cron job runs every hour,
                but you can force an immediate sync here.
              </p>
              <Button
                onClick={handleSync}
                disabled={isSyncing || stats.pendingSync === 0}
                className="w-full h-14 bg-amber-500 hover:bg-amber-600 text-white font-bold text-base rounded-xl shadow-sm transition-all"
              >
                {isSyncing ? (
                  <Loader2 className="w-5 h-5 animate-spin mr-2" />
                ) : (
                  <RefreshCcw className="w-5 h-5 mr-2" />
                )}
                {stats.pendingSync === 0 && !isSyncing
                  ? "Google Sheets is Up to Date"
                  : "Force Sheets Sync Now"}
              </Button>
            </div>
          </div>

          {/* Database Backups */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
            <div className="p-5 sm:p-6 border-b border-slate-100 bg-blue-50/30 flex items-center gap-3">
              <Database className="w-5 h-5 text-blue-600" />
              <h3 className="font-bold text-lg text-slate-800">Data Backups & Offline Sync</h3>
            </div>
            <div className="p-5 sm:p-6 flex-1 flex flex-col justify-center gap-4">
              <p className="text-sm text-slate-500 font-medium mb-1">
                Download the complete, real-time database to your local machine for offline scanning
                or analysis.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Button
                  onClick={() => handleExport("csv")}
                  disabled={isExporting !== null}
                  variant="outline"
                  className="h-14 border-slate-200 font-bold text-slate-700 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200 rounded-xl transition-all"
                >
                  {isExporting === "csv" ? (
                    <Loader2 className="w-5 h-5 animate-spin mr-2 text-emerald-600" />
                  ) : (
                    <FileSpreadsheet className="w-5 h-5 mr-2 text-emerald-600" />
                  )}
                  Export CSV (Excel)
                </Button>

                <Button
                  onClick={() => handleExport("sql")}
                  disabled={isExporting !== null}
                  variant="outline"
                  className="h-14 border-slate-200 font-bold text-slate-700 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200 rounded-xl transition-all"
                >
                  {isExporting === "sql" ? (
                    <Loader2 className="w-5 h-5 animate-spin mr-2 text-blue-600" />
                  ) : (
                    <Database className="w-5 h-5 mr-2 text-blue-600" />
                  )}
                  Export SQLite (.sql)
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
