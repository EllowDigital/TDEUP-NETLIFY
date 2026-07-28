"use client";

import { useState, useRef, useCallback } from "react";
import { Scanner } from "@yudiel/react-qr-scanner";
import {
  CheckCircle2,
  XCircle,
  QrCode,
  Keyboard,
  User,
  Loader2,
  RefreshCcw,
  Search,
  Phone,
  Hash,
  CameraOff,
  Camera,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// The shape of the data we expect from the SuccessPass QR code or DB
interface ParsedQRData {
  attendeeId: string;
  fullName?: string;
  attendeeType?: string;
  organization?: string;
  category?: string;
}

export default function CheckInPage() {
  const [activeTab, setActiveTab] = useState<"SCAN" | "MANUAL">("SCAN");
  const [inputValue, setInputValue] = useState("");

  const [scannedUser, setScannedUser] = useState<ParsedQRData | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [isCheckingIn, setIsCheckingIn] = useState(false);

  // NEW: Camera Toggle to save battery
  const [isCameraActive, setIsCameraActive] = useState(true);

  // NEW: Scan Lock to prevent double-scanning the same code in milliseconds
  const scanLock = useRef(false);

  // Status: null (waiting), 'success', or 'error'
  const [apiStatus, setApiStatus] = useState<{ type: "success" | "error"; message: string } | null>(
    null
  );

  // Handle successful QR scan (Optimized for instant processing)
  const handleScan = useCallback((text: string) => {
    if (scanLock.current) return;
    scanLock.current = true; // Lock scanner immediately

    // Hardware haptic feedback for instantaneous feel (mobile only)
    try {
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate([100]);
      }
    } catch (e) {
      // Ignore if device doesn't support vibration
    }

    try {
      // Try to parse the JSON embedded in the QR Code
      const data: ParsedQRData = JSON.parse(text);
      if (data.attendeeId) {
        setScannedUser(data);
        setIsCameraActive(false); // INSTANTLY turn off camera to save battery
      } else {
        setApiStatus({ type: "error", message: "Invalid QR format. No Attendee ID found." });
        // Unlock after 2 seconds so they can try again
        setTimeout(() => {
          scanLock.current = false;
        }, 2000);
      }
    } catch (e) {
      // Fallback: If it's just a raw text ID (e.g. TDE26-G-XXXXXX) instead of JSON
      if (text.startsWith("TDE26-")) {
        setScannedUser({ attendeeId: text, fullName: "Legacy QR Pass" });
        setIsCameraActive(false); // INSTANTLY turn off camera
      } else {
        setApiStatus({ type: "error", message: "Unrecognized QR Code format." });
        setTimeout(() => {
          scanLock.current = false;
        }, 2000);
      }
    }
  }, []);

  // Handle Manual Entry Submit (Supports both ID and Phone Number)
  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const input = inputValue.trim();
    if (!input) return;

    // Clean input to check if it's a mobile number (only digits)
    const numericInput = input.replace(/\D/g, "");
    const isMobile = numericInput.length >= 10;

    if (isMobile) {
      setIsSearching(true);
      setApiStatus(null);
      try {
        const res = await fetch("/api/find-pass", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mobile: numericInput }),
        });

        const data = await res.json();

        if (res.ok && data.attendee) {
          setScannedUser({
            attendeeId: data.attendee.attendee_id,
            fullName: data.attendee.full_name,
            attendeeType: data.attendee.attendee_type,
            organization: data.attendee.business_name || "N/A",
          });
        } else {
          setApiStatus({
            type: "error",
            message: data.message || "No pass found for this mobile number.",
          });
        }
      } catch (err) {
        setApiStatus({ type: "error", message: "Network error while searching for user." });
      } finally {
        setIsSearching(false);
      }
    } else {
      setScannedUser({ attendeeId: input.toUpperCase() });
    }
  };

  // Call the API to mark them as Checked In
  const processCheckIn = async () => {
    if (!scannedUser?.attendeeId) return;

    setIsCheckingIn(true);
    setApiStatus(null);

    try {
      const res = await fetch("/api/check-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attendee_id: scannedUser.attendeeId }),
      });

      const result = await res.json();

      if (res.ok) {
        setApiStatus({ type: "success", message: result.message });
      } else {
        setApiStatus({ type: "error", message: result.message });
      }
    } catch (error) {
      setApiStatus({ type: "error", message: "Network error. Please check your connection." });
    } finally {
      setIsCheckingIn(false);
    }
  };

  // Reset the screen for the next person
  const resetScanner = () => {
    setScannedUser(null);
    setApiStatus(null);
    setInputValue("");
    scanLock.current = false; // Unlock the scanner
    setIsCameraActive(true); // Turn camera back on
  };

  return (
    <div className="min-h-screen bg-slate-50/80 py-8 px-4 flex flex-col items-center selection:bg-blue-100 font-sans">
      <div className="w-full max-w-md animate-in fade-in slide-in-from-bottom-4 duration-500">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight">Scanner Portal</h1>
          <p className="text-slate-500 font-medium mt-1.5 text-sm">
            Scan QR or enter Phone/ID to grant entry.
          </p>
        </div>

        {/* STEP 1: Scanning / Input Mode */}
        {!scannedUser && (
          <div className="bg-white rounded-[2rem] shadow-sm border border-slate-200 overflow-hidden">
            {/* Modern Segmented Control Tab */}
            <div className="p-2 bg-slate-50/50 border-b border-slate-100">
              <div className="flex bg-slate-100 p-1 rounded-2xl">
                <button
                  onClick={() => {
                    setActiveTab("SCAN");
                    setApiStatus(null);
                  }}
                  className={`flex-1 py-3 font-bold text-sm flex items-center justify-center gap-2 rounded-xl transition-all ${
                    activeTab === "SCAN"
                      ? "bg-white text-blue-700 shadow-sm"
                      : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  <QrCode className="w-4 h-4" /> Scan QR
                </button>
                <button
                  onClick={() => {
                    setActiveTab("MANUAL");
                    setApiStatus(null);
                    setIsCameraActive(false); // Turn off camera if they switch to manual
                  }}
                  className={`flex-1 py-3 font-bold text-sm flex items-center justify-center gap-2 rounded-xl transition-all ${
                    activeTab === "MANUAL"
                      ? "bg-white text-blue-700 shadow-sm"
                      : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  <Keyboard className="w-4 h-4" /> Manual Entry
                </button>
              </div>
            </div>

            {/* Content Area */}
            <div className="p-6">
              {activeTab === "SCAN" ? (
                <div className="space-y-5 animate-in fade-in duration-300">
                  <div className="aspect-square rounded-3xl overflow-hidden bg-slate-900 relative shadow-inner flex items-center justify-center">
                    {isCameraActive ? (
                      <>
                        <Scanner
                          onScan={(detectedCodes) => {
                            if (detectedCodes.length > 0) {
                              handleScan(detectedCodes[0].rawValue);
                            }
                          }}
                          // OPTIMIZATION: Only search for QR codes to save CPU and scan instantly
                          formats={["qr_code"]}
                          styles={{ container: { width: "100%", height: "100%" } }}
                        />
                        {/* Scanner Overlay UI */}
                        <div className="absolute inset-0 border-[50px] border-black/40 pointer-events-none z-10 flex items-center justify-center">
                          <div className="w-full h-full border-2 border-white/50 rounded-xl" />
                        </div>
                        {/* Pause Camera Button */}
                        <button
                          onClick={() => setIsCameraActive(false)}
                          className="absolute top-4 right-4 z-20 bg-black/60 hover:bg-black/80 text-white p-2.5 rounded-full backdrop-blur-md transition-transform hover:scale-110 active:scale-95 shadow-lg"
                          title="Pause camera to save battery"
                        >
                          <CameraOff className="w-5 h-5" />
                        </button>
                      </>
                    ) : (
                      // Camera Paused State
                      <div className="flex flex-col items-center justify-center text-white p-6 text-center space-y-4 animate-in zoom-in-95">
                        <div className="p-4 bg-white/10 rounded-full mb-2">
                          <CameraOff className="w-10 h-10 opacity-70" />
                        </div>
                        <div>
                          <h4 className="font-extrabold text-lg tracking-wide">Camera Paused</h4>
                          <p className="text-sm opacity-70 mt-1 font-medium px-4">
                            Tap below to wake up the scanner and save battery.
                          </p>
                        </div>
                        <Button
                          onClick={() => {
                            scanLock.current = false;
                            setIsCameraActive(true);
                          }}
                          className="mt-4 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl h-12 px-6 shadow-lg"
                        >
                          <Camera className="w-5 h-5 mr-2" /> Resume Scanner
                        </Button>
                      </div>
                    )}
                  </div>
                  <p className="text-center text-xs font-bold text-slate-400 uppercase tracking-widest">
                    {isCameraActive ? "Position QR inside the frame" : "Camera is currently off"}
                  </p>
                </div>
              ) : (
                <form
                  onSubmit={handleManualSubmit}
                  className="space-y-5 py-4 animate-in fade-in duration-300"
                >
                  <div className="space-y-1.5">
                    <label className="text-sm font-bold text-slate-700 flex items-center gap-2">
                      Enter Details{" "}
                      <span className="text-slate-400 font-normal">(Phone or ID)</span>
                    </label>
                    <div className="relative">
                      <Input
                        placeholder="9876543210 or TDE26-..."
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        className="h-14 pl-11 text-base tracking-wide font-semibold bg-slate-50 border-slate-200 focus-visible:ring-blue-500/20 uppercase"
                        autoFocus
                      />
                      {inputValue.replace(/\D/g, "").length >= 10 ? (
                        <Phone className="w-5 h-5 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                      ) : (
                        <Hash className="w-5 h-5 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
                      )}
                    </div>
                  </div>
                  <Button
                    type="submit"
                    disabled={!inputValue || isSearching}
                    className="w-full h-14 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-sm transition-all"
                  >
                    {isSearching ? (
                      <>
                        <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Searching Database...
                      </>
                    ) : (
                      <>
                        <Search className="w-5 h-5 mr-2" /> Find Attendee
                      </>
                    )}
                  </Button>
                </form>
              )}
            </div>
          </div>
        )}

        {/* Global Errors (Shown before confirmation screen) */}
        {!scannedUser && apiStatus?.type === "error" && (
          <div className="mt-6 bg-red-50 text-red-700 p-4 rounded-2xl flex items-start gap-3 border border-red-100 shadow-sm animate-in fade-in slide-in-from-top-2">
            <XCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <span className="text-sm font-semibold">{apiStatus.message}</span>
          </div>
        )}

        {/* STEP 2: Scanned User Details & Check-In Action */}
        {scannedUser && (
          <div className="bg-white rounded-[2rem] shadow-lg border border-slate-200 overflow-hidden animate-in zoom-in-95 duration-300">
            {/* User Info Card */}
            <div className="p-6 border-b border-slate-100 bg-gradient-to-b from-slate-50 to-white">
              <div className="flex items-center gap-4 mb-2">
                <div className="p-3 bg-blue-100/50 border border-blue-100 rounded-2xl text-blue-700 shadow-sm">
                  <User className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-widest font-extrabold text-blue-500 mb-0.5">
                    {scannedUser.attendeeType || "Manual ID Entry"}
                  </p>
                  <h3 className="text-xl sm:text-2xl font-black text-slate-900 line-clamp-1 leading-tight">
                    {scannedUser.fullName || "Unverified Name"}
                  </h3>
                </div>
              </div>

              <div className="mt-5 space-y-2.5 bg-slate-50 p-4 rounded-2xl border border-slate-100">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-slate-500 font-semibold">Pass ID</span>
                  <span className="font-mono font-bold text-slate-800 bg-white px-2 py-1 rounded-md border border-slate-200">
                    {scannedUser.attendeeId}
                  </span>
                </div>
                {scannedUser.organization && scannedUser.organization !== "N/A" && (
                  <div className="flex justify-between items-center text-sm pt-2 border-t border-slate-200/60">
                    <span className="text-slate-500 font-semibold">Company</span>
                    <span className="font-bold text-slate-800 text-right">
                      {scannedUser.organization}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Actions & Status */}
            <div className="p-6">
              {apiStatus ? (
                // Show Result of Check-In API
                <div className="space-y-4 animate-in fade-in zoom-in-95 duration-300">
                  <div
                    className={`flex flex-col items-center justify-center p-8 rounded-3xl border-2 text-center shadow-sm ${
                      apiStatus.type === "success"
                        ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                        : "bg-red-50 border-red-200 text-red-800"
                    }`}
                  >
                    {apiStatus.type === "success" ? (
                      <CheckCircle2 className="w-14 h-14 mb-4 text-emerald-500 drop-shadow-sm" />
                    ) : (
                      <XCircle className="w-14 h-14 mb-4 text-red-500 drop-shadow-sm" />
                    )}
                    <h4 className="text-xl font-black mb-1.5 tracking-tight">
                      {apiStatus.type === "success" ? "Access Granted" : "Access Denied"}
                    </h4>
                    <p className="text-sm font-semibold opacity-90">{apiStatus.message}</p>
                  </div>

                  <Button
                    onClick={resetScanner}
                    className="w-full h-14 bg-slate-900 hover:bg-slate-800 text-white font-bold rounded-xl shadow-sm"
                  >
                    <RefreshCcw className="w-4 h-4 mr-2" /> Scan Next Attendee
                  </Button>
                </div>
              ) : (
                // Show Confirmation Button
                <div className="space-y-3">
                  <Button
                    onClick={processCheckIn}
                    disabled={isCheckingIn}
                    className="w-full h-16 text-lg font-black rounded-2xl bg-blue-600 hover:bg-blue-700 text-white shadow-[0_8px_20px_rgba(37,99,235,0.2)] transition-all hover:-translate-y-0.5 active:translate-y-0"
                  >
                    {isCheckingIn ? (
                      <>
                        <Loader2 className="w-6 h-6 mr-2 animate-spin" /> Verifying Server...
                      </>
                    ) : (
                      "Confirm Check-In"
                    )}
                  </Button>
                  <Button
                    onClick={resetScanner}
                    variant="ghost"
                    className="w-full h-12 font-bold text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-xl"
                  >
                    Cancel & Go Back
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
