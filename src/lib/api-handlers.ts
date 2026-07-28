// src/lib/api-handlers.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { v2 as cloudinary } from "cloudinary";

// Ensure you have your schema file correctly imported
import { formSchema } from "./schema";

// ---------------------------------------------------------
// Configuration & Global Settings (Cold-Start Optimized)
// ---------------------------------------------------------
// OPTIMIZATION: Initialize clients outside the handlers so they are
// cached and reused across API calls in the serverless container.

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase environment variables");
}
const supabase = createClient(supabaseUrl, supabaseKey);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// ---------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------
// COLLISION-PROOF ID: Mixes base36 timestamp with random chars
function generateUniqueId(typeInitial: string) {
  const timeFragment = Date.now().toString(36).toUpperCase().slice(-4);
  let randomFragment = "";
  for (let i = 0; i < 4; i++) {
    randomFragment += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return `TDE26-${typeInitial}-${timeFragment}${randomFragment}`;
}

// 🛡️ ROBUST FEATURE: Cloudinary upload with strict timeouts, retries, and no-overwrite
async function uploadToCloudinary(
  buffer: Buffer,
  mobile: string,
  retries = 2
): Promise<string | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: "TDEUP_Visitors",
            public_id: mobile, // Strict naming by mobile number
            overwrite: false, // Save bandwidth, don't overwrite existing
            resource_type: "image",
            timeout: 15000, // 15s timeout for slow networks
          },
          (error, result) => {
            if (result) resolve(result.secure_url);
            else reject(error);
          }
        );
        uploadStream.end(buffer);
      });
    } catch (error) {
      if (attempt === retries) return null;
      await new Promise((r) => setTimeout(r, 1000)); // Wait 1s before retry
    }
  }
  return null;
}

// Helper to return consistent JSON responses
function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status });
}

// Helper to escape single quotes safely for SQLite
const escapeSQL = (val: string | null | undefined) => {
  if (val === null || val === undefined || val === "") return "NULL";
  return `'${String(val).replace(/'/g, "''")}'`;
};

// Helper for strict CSV escaping
const escapeCSV = (val: any) => {
  if (val === null || val === undefined || val === "") return '""';
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

// ---------------------------------------------------------
// 1. FIND PASS
// ---------------------------------------------------------
export async function postFindPass(req: NextRequest) {
  try {
    let body;
    try {
      body = await req.json();
    } catch (parseError) {
      return jsonResponse(
        { success: false, message: "Invalid JSON payload. | अमान्य JSON पेलोड।" },
        400
      );
    }

    const rawMobile = body?.mobile;

    if (!rawMobile || typeof rawMobile !== "string") {
      return jsonResponse(
        {
          success: false,
          message: "A valid mobile number is required. | एक वैध मोबाइल नंबर आवश्यक है।",
        },
        400
      );
    }

    // SANITIZE: Strip non-digits to match DB constraint
    const cleanMobile = rawMobile.replace(/\D/g, "");

    if (cleanMobile.length < 10) {
      return jsonResponse(
        {
          success: false,
          message:
            "Please enter a valid 10-digit mobile number. | कृपया 10 अंकों का वैध मोबाइल नंबर दर्ज करें।",
        },
        400
      );
    }

    // OPTIMIZATION: Explicitly select only mapped fields to save memory
    const { data, error } = await supabase
      .from("attendees")
      .select(
        `
        attendee_id, full_name, mobile, email, gender, attendee_type, 
        business_name, business_category, other_category, 
        address, city, state, pincode, attendance_days, photo_url
      `
      )
      .eq("mobile", cleanMobile)
      .maybeSingle();

    if (error) {
      console.error("Supabase Error [Find Pass]:", error);
      throw new Error("Database query failed.");
    }

    if (!data) {
      return jsonResponse(
        {
          success: false,
          message:
            "No pass found for this mobile number. Please register first. | इस मोबाइल नंबर के लिए कोई पास नहीं मिला। कृपया पहले पंजीकरण करें।",
        },
        404
      );
    }

    return jsonResponse({ success: true, attendee: data }, 200);
  } catch (error: any) {
    console.error("Find Pass Error:", error);
    return jsonResponse({ success: false, message: "Server error | सर्वर त्रुटि" }, 500);
  }
}

// ---------------------------------------------------------
// 2. CHECK IN (Multi-Day Logic & Test Mode)
// ---------------------------------------------------------
export async function postCheckIn(req: NextRequest) {
  try {
    // ==========================================
    // ⚙️ EVENT CONFIGURATION & TEST MODE
    // ==========================================
    const IS_TEST_MODE = false; // ⚠️ CHANGE TO 'false' FOR THE LIVE EVENT
    const testDate = new Date(2026, 7, 30, 10, 0, 0); // 30 August 2026
    // ==========================================

    let body;
    try {
      body = await req.json();
    } catch (parseError) {
      return jsonResponse(
        { success: false, message: "Invalid JSON payload. | अमान्य JSON पेलोड।" },
        400
      );
    }

    const rawAttendeeId = body?.attendee_id;

    if (!rawAttendeeId || typeof rawAttendeeId !== "string" || rawAttendeeId.trim() === "") {
      return jsonResponse(
        {
          success: false,
          message: "A valid Attendee ID is required. | एक वैध अटेंडी आईडी आवश्यक है।",
        },
        400
      );
    }
    const attendee_id = rawAttendeeId.trim();

    const userAgent = req.headers.get("user-agent") || "Online Web Portal";

    const { data: user, error: fetchError } = await supabase
      .from("attendees")
      .select("full_name, attendance_days, checkin_history")
      .eq("attendee_id", attendee_id)
      .maybeSingle();

    if (fetchError || !user) {
      return jsonResponse(
        {
          success: false,
          message: "Invalid Pass. Attendee not found. | अमान्य पास। उपस्थित व्यक्ति नहीं मिला।",
        },
        404
      );
    }

    const dateIST = IS_TEST_MODE
      ? testDate
      : new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));

    const day = dateIST.getDate();
    const year = dateIST.getFullYear();
    const monthNum = String(dateIST.getMonth() + 1).padStart(2, "0");
    const dayNum = String(day).padStart(2, "0");

    const dateCode = `${year}-${monthNum}-${dayNum}`;
    const monthNames = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    const month = monthNames[dateIST.getMonth()];
    const todayKey = `${day} ${month}`;

    const attendanceDays = user.attendance_days || [];
    if (!attendanceDays.includes(todayKey)) {
      return jsonResponse(
        {
          success: false,
          message: `Access Denied: ${user.full_name} does not have a pass for today (${todayKey}). | प्रवेश वर्जित: आज के लिए पास नहीं है।`,
        },
        403
      );
    }

    const history = user.checkin_history || {};
    if (history[todayKey]) {
      return jsonResponse(
        {
          success: false,
          message: `${user.full_name} is already checked in for today. | आज के लिए पहले ही चेक-इन कर चुके हैं।`,
        },
        409
      );
    }

    // Add check-in using unified format
    history[todayKey] = {
      timestamp: new Date().toISOString(),
      source: "online_portal",
      device: userAgent.substring(0, 80),
      date_code: dateCode,
      display_date: todayKey,
    };

    const { error: updateError } = await supabase
      .from("attendees")
      .update({
        checkin_history: history,
        needs_sheet_sync: true,
        needs_local_sync: true,
      })
      .eq("attendee_id", attendee_id);

    if (updateError) {
      console.error("Database Update Error [Check-in]:", updateError);
      throw new Error("Failed to save check-in to database.");
    }

    let successMessage = `Day ${day} Access Granted! Welcome ${user.full_name}! | प्रवेश स्वीकृत! आपका स्वागत है!`;
    if (IS_TEST_MODE) successMessage += ` [TEST MODE: ${todayKey}]`;

    return jsonResponse({ success: true, message: successMessage }, 200);
  } catch (error: any) {
    console.error("Check-in Route Error:", error);
    return jsonResponse(
      {
        success: false,
        message: "A server error occurred during check-in. | चेक-इन के दौरान सर्वर त्रुटि हुई।",
      },
      500
    );
  }
}

// ---------------------------------------------------------
// 3. REGISTER
// ---------------------------------------------------------
export async function postRegister(req: NextRequest) {
  try {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch (err) {
      return jsonResponse(
        {
          success: false,
          message: "Invalid form data submission format. | अमान्य फ़ॉर्म डेटा सबमिशन प्रारूप।",
        },
        400
      );
    }

    const rawMobile = (formData.get("mobile") as string) || "";
    const mobile = rawMobile.replace(/\D/g, "");

    if (!mobile || mobile.length < 10) {
      return jsonResponse(
        {
          success: false,
          message:
            "A valid 10-digit mobile number is required. | एक वैध 10-अंकीय मोबाइल नंबर आवश्यक है।",
        },
        400
      );
    }

    // CHECK IF USER ALREADY EXISTS (Prevents wasted processing)
    const { data: existingUser } = await supabase
      .from("attendees")
      .select("attendee_id")
      .eq("mobile", mobile)
      .maybeSingle();

    if (existingUser) {
      return jsonResponse(
        {
          success: false,
          attendeeId: existingUser.attendee_id,
          message:
            "You are already registered! Please click download pass to retrieve it. | आप पहले से ही पंजीकृत हैं! कृपया पास प्राप्त करने के लिए डाउनलोड पर क्लिक करें।",
        },
        409
      );
    }

    const attendeeType = (formData.get("attendeeType") as string) || "GENERAL";
    const businessName = (formData.get("businessName") as string)?.trim() || "";
    const businessCategory = (formData.get("businessCategory") as string)?.trim() || "";
    const otherCategory = (formData.get("otherCategory") as string)?.trim() || "";
    const fullName = (formData.get("fullName") as string)?.trim() || "";
    const email = (formData.get("email") as string)?.trim().toLowerCase() || "";
    const gender = (formData.get("gender") as string) || "";
    const address = (formData.get("address") as string)?.trim() || "";
    const city = (formData.get("city") as string)?.trim() || "";
    const state = (formData.get("state") as string)?.trim() || "";
    const pincode = (formData.get("pincode") as string)?.trim() || "";

    const rawAttendance = formData.get("attendance") as string;
    let attendanceArray: string[] = [];
    try {
      attendanceArray = JSON.parse(rawAttendance);
    } catch {
      attendanceArray = rawAttendance ? [rawAttendance] : [];
    }

    if (attendeeType !== "GENERAL" && !businessName) {
      return jsonResponse(
        {
          success: false,
          message:
            "Business/Firm name is required for your visitor type. | आपके विज़िटर प्रकार के लिए व्यवसाय/फर्म का नाम आवश्यक है।",
        },
        400
      );
    }

    // ZOD DATA VALIDATION
    const validationResult = formSchema.safeParse({
      fullName,
      mobile,
      email,
      gender,
      attendeeType,
      businessCategory,
      otherCategory,
      businessName,
      address,
      state,
      city,
      pincode,
      attendance: attendanceArray,
    });

    if (!validationResult.success) {
      return jsonResponse(
        {
          success: false,
          message:
            validationResult.error.issues[0]?.message ||
            "Please complete all fields correctly. | कृपया सभी फ़ील्ड सही ढंग से भरें।",
        },
        400
      );
    }

    const photoFile = formData.get("photo") as File | null;
    if (!photoFile || photoFile.size === 0) {
      return jsonResponse(
        { success: false, message: "Profile photo is required. | प्रोफ़ाइल फ़ोटो आवश्यक है।" },
        400
      );
    }

    const typeInitial = attendeeType.charAt(0).toUpperCase();
    const attendee_id = generateUniqueId(typeInitial);
    let normalizedOtherCategory: string | null = otherCategory || null;
    if (businessCategory !== "OTHER" || !normalizedOtherCategory) {
      normalizedOtherCategory = null;
    }

    const chronologicalOrder: Record<string, number> = {
      "30 August": 1,
      "31 August": 2,
      "1 September": 3,
    };
    attendanceArray.sort((a, b) => (chronologicalOrder[a] || 99) - (chronologicalOrder[b] || 99));

    const buffer = Buffer.from(await photoFile.arrayBuffer());
    const photoUrl = await uploadToCloudinary(buffer, mobile);

    if (!photoUrl) {
      return jsonResponse(
        {
          success: false,
          message:
            "Network too slow. Photo upload timed out. Please try again. | नेटवर्क बहुत धीमा है। फ़ोटो अपलोड समय समाप्त। कृपया पुनः प्रयास करें।",
        },
        502
      );
    }

    // FAST SUPABASE INSERT
    const { error: insertError } = await supabase.from("attendees").insert([
      {
        attendee_id,
        full_name: fullName,
        mobile,
        email: email || null,
        gender,
        attendee_type: attendeeType,
        business_name: businessName || null,
        business_category: businessCategory || null,
        other_category: normalizedOtherCategory,
        address,
        city,
        state,
        pincode,
        attendance_days: attendanceArray,
        photo_url: photoUrl,
        checkin_history: {},
        needs_local_sync: true,
        needs_cloud_sync: false,
        needs_sheet_sync: true,
      },
    ]);

    // RACE-CONDITION FALLBACK (Double submit unique constraint)
    if (insertError) {
      if (insertError.code === "23505" && insertError.message.includes("mobile")) {
        const { data: raceConditionUser } = await supabase
          .from("attendees")
          .select("attendee_id")
          .eq("mobile", mobile)
          .single();
        return jsonResponse(
          {
            success: false,
            attendeeId: raceConditionUser?.attendee_id,
            message:
              "You are already registered! Please click download pass to retrieve it. | आप पहले से ही पंजीकृत हैं! कृपया पास प्राप्त करने के लिए डाउनलोड पर क्लिक करें।",
          },
          409
        );
      }
      console.error("Database error during insert:", insertError);
      throw new Error("Failed to create registration record.");
    }

    // EXPLICITLY REMOVED AUTOMATIC GOOGLE SHEETS SYNC HERE.
    // Sync will only happen when manually triggered via the Admin Dashboard.

    return jsonResponse(
      {
        success: true,
        attendeeId: attendee_id,
        message: "Registration successful! Pass generated. | पंजीकरण सफल! पास बन गया है।",
      },
      201
    );
  } catch (error: any) {
    console.error("Critical System Error:", error);
    return jsonResponse(
      {
        success: false,
        message:
          "An unexpected error occurred. Please try again. | एक अप्रत्याशित त्रुटि हुई। कृपया पुनः प्रयास करें।",
      },
      500
    );
  }
}

// ---------------------------------------------------------
// 4. ADMIN STATS
// ---------------------------------------------------------
export async function getAdminStats() {
  try {
    // OPTIMIZATION: Execute all 4 HEAD queries concurrently via Promise.all.
    const [totalResult, pendingSheetResult, pendingLocalResult, checkedInResult] =
      await Promise.all([
        supabase.from("attendees").select("*", { count: "exact", head: true }),
        supabase
          .from("attendees")
          .select("*", { count: "exact", head: true })
          .eq("needs_sheet_sync", true),
        supabase
          .from("attendees")
          .select("*", { count: "exact", head: true })
          .eq("needs_local_sync", true),
        supabase
          .from("attendees")
          .select("*", { count: "exact", head: true })
          .neq("checkin_history", "{}"),
      ]);

    if (totalResult.error) throw totalResult.error;
    if (pendingSheetResult.error) throw pendingSheetResult.error;
    if (pendingLocalResult.error) throw pendingLocalResult.error;
    if (checkedInResult.error) throw checkedInResult.error;

    return NextResponse.json(
      {
        success: true,
        total: totalResult.count ?? 0,
        pendingSync: pendingSheetResult.count ?? 0,
        pendingLocalSync: pendingLocalResult.count ?? 0,
        checkedIn: checkedInResult.count ?? 0,
        timestamp: new Date().toISOString(),
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
      }
    );
  } catch (error: any) {
    console.error("Stats Error:", error);
    return jsonResponse(
      {
        success: false,
        message: "Server error while fetching stats | आँकड़े लाते समय सर्वर त्रुटि",
      },
      500
    );
  }
}

// ---------------------------------------------------------
// 5. ADMIN SYNC (UPSERT LOGIC)
// ---------------------------------------------------------
export async function postAdminSync() {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    if (!spreadsheetId) {
      return jsonResponse(
        { success: false, message: "Google Sheet ID is missing. | Google Sheet ID मौजूद नहीं है।" },
        500
      );
    }

    // Increased limit to 300 for efficiency
    const { data: attendeesToSync, error: fetchError } = await supabase
      .from("attendees")
      .select("*")
      .eq("needs_sheet_sync", true)
      .limit(300);

    if (fetchError) {
      return jsonResponse(
        {
          success: false,
          message:
            "Failed to fetch records from database. | डेटाबेस से रिकॉर्ड प्राप्त करने में विफल।",
        },
        500
      );
    }

    if (!attendeesToSync || attendeesToSync.length === 0) {
      return jsonResponse(
        {
          success: true,
          message:
            "Everything is up to date. No records to sync. | सब कुछ अपडेट है। सिंक करने के लिए कोई रिकॉर्ड नहीं है।",
        },
        200
      );
    }

    const existingIdsResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A:A",
    });

    const existingRows = existingIdsResponse.data.values || [];
    const rowIndexMap = new Map<string, number>();
    existingRows.forEach((row, index) => {
      if (row[0]) rowIndexMap.set(row[0].trim(), index + 1);
    });

    const updateData: any[] = [];
    const appendData: any[] = [];
    const successfullyProcessedIds: string[] = [];

    attendeesToSync.forEach((attendee) => {
      let checkinStatus = "Not Checked In";
      if (attendee.checkin_history && typeof attendee.checkin_history === "object") {
        const historyKeys = Object.keys(attendee.checkin_history);
        if (historyKeys.length > 0) {
          checkinStatus = Object.entries(attendee.checkin_history)
            .map(([date, details]: [string, any]) => {
              if (typeof details === "string") return `${date} (${details})`;
              if (typeof details === "object" && details !== null)
                return `${date} (${details.source || "Checked In"})`;
              return `${date}`;
            })
            .join(" | ");
        }
      }

      const formattedRow = [
        attendee.attendee_id,
        attendee.full_name,
        attendee.mobile,
        attendee.email || "N/A",
        attendee.gender,
        attendee.attendee_type,
        attendee.business_name || "N/A",
        attendee.business_category || "N/A",
        attendee.other_category || "N/A",
        attendee.address,
        attendee.city,
        attendee.state,
        attendee.pincode,
        (attendee.attendance_days || []).join(", "),
        attendee.photo_url || "N/A",
        checkinStatus,
        new Date(attendee.updated_at || attendee.created_at).toISOString(),
      ];

      const existingRowNumber = rowIndexMap.get(attendee.attendee_id);
      if (existingRowNumber) {
        updateData.push({
          range: `Sheet1!A${existingRowNumber}:Q${existingRowNumber}`,
          values: [formattedRow],
        });
      } else {
        appendData.push(formattedRow);
      }
      successfullyProcessedIds.push(attendee.id);
    });

    try {
      const sheetPromises = [];

      // OPTIMIZATION: Concurrently batch update and append
      if (updateData.length > 0) {
        sheetPromises.push(
          sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: { valueInputOption: "USER_ENTERED", data: updateData },
          })
        );
      }
      if (appendData.length > 0) {
        sheetPromises.push(
          sheets.spreadsheets.values.append({
            spreadsheetId,
            range: "Sheet1!A:Q",
            valueInputOption: "USER_ENTERED",
            requestBody: { values: appendData },
          })
        );
      }
      await Promise.all(sheetPromises);
    } catch (sheetError) {
      console.error("Google Sheets API Error:", sheetError);
      return jsonResponse(
        {
          success: false,
          message: "Failed to write to Google Sheets. | Google Sheets में लिखने में विफल।",
        },
        502
      );
    }

    if (successfullyProcessedIds.length > 0) {
      const { error: updateError } = await supabase
        .from("attendees")
        .update({ needs_sheet_sync: false })
        .in("id", successfullyProcessedIds);

      if (updateError) {
        return jsonResponse(
          {
            success: false,
            message:
              "Synced to sheets, but failed to clear flags. | शीट्स से सिंक किया गया, लेकिन फ़्लैग साफ़ करने में विफल।",
          },
          500
        );
      }
    }

    return jsonResponse(
      {
        success: true,
        message: `Successfully synced ${successfullyProcessedIds.length} records (${updateData.length} updated, ${appendData.length} new). | सफलतापूर्वक सिंक किए गए।`,
      },
      200
    );
  } catch (error: any) {
    console.error("Sync API Error:", error);
    return jsonResponse(
      {
        success: false,
        message: "System error occurred during sync. | सिंक के दौरान सिस्टम त्रुटि हुई।",
      },
      500
    );
  }
}

// ---------------------------------------------------------
// 6. ADMIN EXPORT
// ---------------------------------------------------------
export async function getAdminExport(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const format = url.searchParams.get("format") || "csv";

    const { data: attendees, error } = await supabase
      .from("attendees")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;
    if (!attendees || attendees.length === 0) {
      return new NextResponse("No data found to export", { status: 404 });
    }

    if (format === "sql") {
      // OPTIMIZATION: High-performance array pushing for string building
      const sqlLines: string[] = [];

      sqlLines.push(`-- TDEUP SQLite3 Database Dump`);
      sqlLines.push(`CREATE TABLE IF NOT EXISTS attendees (`);
      sqlLines.push(`  id TEXT PRIMARY KEY,`);
      sqlLines.push(`  attendee_id TEXT UNIQUE,`);
      sqlLines.push(`  full_name TEXT,`);
      sqlLines.push(`  mobile TEXT,`);
      sqlLines.push(`  email TEXT,`);
      sqlLines.push(`  gender TEXT,`);
      sqlLines.push(`  attendee_type TEXT,`);
      sqlLines.push(`  business_name TEXT,`);
      sqlLines.push(`  business_category TEXT,`);
      sqlLines.push(`  other_category TEXT,`);
      sqlLines.push(`  address TEXT,`);
      sqlLines.push(`  city TEXT,`);
      sqlLines.push(`  state TEXT,`);
      sqlLines.push(`  pincode TEXT,`);
      sqlLines.push(`  attendance_days TEXT,`);
      sqlLines.push(`  photo_url TEXT,`);
      sqlLines.push(`  checkin_history TEXT,`);
      sqlLines.push(`  needs_cloud_sync INTEGER,`);
      sqlLines.push(`  needs_sheet_sync INTEGER,`);
      sqlLines.push(`  needs_local_sync INTEGER,`);
      sqlLines.push(`  created_at DATETIME`);
      sqlLines.push(`);\n`);

      sqlLines.push(`BEGIN TRANSACTION;`);

      attendees.forEach((row) => {
        const days = Array.isArray(row.attendance_days)
          ? row.attendance_days.join(", ")
          : row.attendance_days;
        const historyStr = JSON.stringify(row.checkin_history || {});

        let rowSql = `INSERT OR REPLACE INTO attendees (id, attendee_id, full_name, mobile, email, gender, attendee_type, business_name, business_category, other_category, address, city, state, pincode, attendance_days, photo_url, checkin_history, needs_cloud_sync, needs_sheet_sync, needs_local_sync, created_at) VALUES (`;
        rowSql += `${escapeSQL(row.id)}, ${escapeSQL(row.attendee_id)}, ${escapeSQL(row.full_name)}, ${escapeSQL(row.mobile)}, ${escapeSQL(row.email)}, ${escapeSQL(row.gender)}, ${escapeSQL(row.attendee_type)}, ${escapeSQL(row.business_name)}, ${escapeSQL(row.business_category)}, ${escapeSQL(row.other_category)}, ${escapeSQL(row.address)}, ${escapeSQL(row.city)}, ${escapeSQL(row.state)}, ${escapeSQL(row.pincode)}, ${escapeSQL(days)}, ${escapeSQL(row.photo_url)}, ${escapeSQL(historyStr)}, `;
        rowSql += `${row.needs_cloud_sync ? 1 : 0}, ${row.needs_sheet_sync ? 1 : 0}, ${row.needs_local_sync ? 1 : 0}, ${escapeSQL(row.created_at)});`;
        sqlLines.push(rowSql);
      });

      sqlLines.push(`COMMIT;`);

      return new NextResponse(sqlLines.join("\n"), {
        headers: {
          "Content-Type": "application/sql",
          "Content-Disposition": `attachment; filename="tdeup_export.sql"`,
          "Cache-Control": "no-store, must-revalidate",
        },
      });
    }

    // CSV EXPORT
    const headers = Object.keys(attendees[0]);
    const csvLines: string[] = [];
    csvLines.push(headers.join(","));

    attendees.forEach((row) => {
      const values = headers.map((header) => {
        let val = row[header];
        if (Array.isArray(val)) {
          val = val.join(", ");
        } else if (val !== null && typeof val === "object") {
          const keys = Object.keys(val);
          val = keys.length > 0 ? keys.join(", ") : "Not Checked In";
        }
        return escapeCSV(val);
      });
      csvLines.push(values.join(","));
    });

    return new NextResponse(csvLines.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="tdeup_export.csv"`,
        "Cache-Control": "no-store, must-revalidate",
      },
    });
  } catch (error: any) {
    console.error("Critical Export Error:", error);
    return new NextResponse("Failed to generate export file. Please check server logs.", {
      status: 500,
    });
  }
}
