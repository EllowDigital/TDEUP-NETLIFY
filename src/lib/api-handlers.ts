// src/lib/api-handlers.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { v2 as cloudinary } from "cloudinary";

// Ensure you have your schema file correctly imported
import { formSchema } from "./schema";

// ---------------------------------------------------------
// Configuration & Global Settings
// ---------------------------------------------------------
function getSupabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing Supabase environment variables");
  }

  return createClient(supabaseUrl, supabaseKey);
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// ---------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------
function generateCode(length = 6) {
  let code = "";
  for (let index = 0; index < length; index++) {
    code += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return code;
}

// 🛡️ ROBUST FEATURE: Cloudinary upload with strict timeouts & retries
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
            public_id: mobile,
            overwrite: true,
            timeout: 10000, // Strict 10-second timeout to prevent server crash
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
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return null;
}

// 🛡️ CRITICAL FIX: Use NextResponse to prevent Netlify timeouts
function jsonResponse(body: unknown, status = 200) {
  return NextResponse.json(body, { status });
}

// ---------------------------------------------------------
// 1. FIND PASS
// ---------------------------------------------------------
// 🛡️ CRITICAL FIX: Use NextRequest
export async function postFindPass(req: NextRequest) {
  try {
    const { mobile } = await req.json();

    if (!mobile || typeof mobile !== "string" || mobile.trim() === "") {
      return jsonResponse({ success: false, message: "A valid mobile number is required." }, 400);
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("attendees")
      .select("*")
      .eq("mobile", mobile.trim())
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return jsonResponse(
        { success: false, message: "No pass found for this mobile number." },
        404
      );
    }

    return jsonResponse({ success: true, attendee: data }, 200);
  } catch (error) {
    console.error("Find Pass Error:", error);
    return jsonResponse({ success: false, message: "Server error" }, 500);
  }
}

// ---------------------------------------------------------
// 2. CHECK IN (Multi-Day Logic & Test Mode)
// ---------------------------------------------------------
// 🛡️ CRITICAL FIX: Use NextRequest
export async function postCheckIn(req: NextRequest) {
  try {
    // ==========================================
    // ⚙️ EVENT CONFIGURATION & TEST MODE
    // ==========================================
    const IS_TEST_MODE = false; // ⚠️ CHANGE TO 'false' FOR THE LIVE EVENT

    // If testing, set the fake date here
    const testDate = new Date(2026, 7, 30, 10, 0, 0);
    // ==========================================

    const { attendee_id } = await req.json();

    // Grab the browser info to act as the "device" name for online check-ins
    const userAgent = req.headers.get("user-agent") || "Online Web Portal";

    if (!attendee_id) {
      return jsonResponse({ success: false, message: "Attendee ID required." }, 400);
    }

    const supabase = getSupabase();

    // 1. Fetch user data
    const { data: user, error: fetchError } = await supabase
      .from("attendees")
      .select("full_name, attendance_days, checkin_history")
      .eq("attendee_id", attendee_id)
      .maybeSingle();

    if (fetchError || !user) {
      return jsonResponse({ success: false, message: "Invalid Pass. Attendee not found." }, 404);
    }

    // 2. Determine "Today's Date" (Using Test Date OR Real IST Date)
    const dateIST = IS_TEST_MODE
      ? testDate
      : new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));

    const day = dateIST.getDate();
    const year = dateIST.getFullYear();
    const monthNum = String(dateIST.getMonth() + 1).padStart(2, "0");
    const dayNum = String(day).padStart(2, "0");

    // Create the machine-readable date_code (e.g., "2026-08-30")
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

    // Create the human-readable display_date (e.g., "30 August")
    const todayKey = `${day} ${month}`;

    // 3. VALIDATION: Did they register for today?
    const attendanceDays = user.attendance_days || [];
    if (!attendanceDays.includes(todayKey)) {
      return jsonResponse(
        {
          success: false,
          message: `Access Denied: ${user.full_name} does not have a pass for today (${todayKey}).`,
        },
        403
      );
    }

    // 4. VALIDATION: Are they already checked in TODAY?
    const history = user.checkin_history || {};
    if (history[todayKey]) {
      return jsonResponse(
        { success: false, message: `${user.full_name} is already checked in for today.` },
        409
      );
    }

    // 5. SUCCESS: Add today's check-in using the UNIFIED JSON FORMAT
    history[todayKey] = {
      timestamp: new Date().toISOString(),
      source: "online_portal",
      device: userAgent.substring(0, 80), // Truncate to keep database clean
      date_code: dateCode,
      display_date: todayKey,
    };

    // 6. Update database with new history AND correct Sync Flags
    const { error: updateError } = await supabase
      .from("attendees")
      .update({
        checkin_history: history,
        needs_sheet_sync: true, // Tells system to update Google Sheets
        needs_local_sync: true, // Tells Laptop-A to download this check-in
      })
      .eq("attendee_id", attendee_id);

    if (updateError) {
      console.error("Database Update Error:", updateError);
      throw new Error("Failed to save check-in to database.");
    }

    // 7. Return Success
    let successMessage = `Day ${day} Access Granted! Welcome ${user.full_name}!`;
    if (IS_TEST_MODE) successMessage += ` [TEST MODE: ${todayKey}]`;

    return jsonResponse({ success: true, message: successMessage }, 200);
  } catch (error: any) {
    console.error("Check-in Route Error:", error);
    return jsonResponse(
      { success: false, message: "A server error occurred during check-in." },
      500
    );
  }
}

// ---------------------------------------------------------
// 3. REGISTER
// ---------------------------------------------------------
// 🛡️ CRITICAL FIX: Use NextRequest to prevent FormData Boundary loss
export async function postRegister(req: NextRequest) {
  try {
    const supabase = getSupabase();
    let formData: FormData;

    // 🛡️ ROBUST FEATURE: Gracefully catch multipart boundary errors
    try {
      formData = await req.formData();
    } catch (err) {
      console.error("FormData Parse Error:", err);
      return jsonResponse({ success: false, message: "Invalid form data submission format." }, 400);
    }

    const mobile = formData.get("mobile") as string;
    if (!mobile || mobile.trim() === "") {
      return jsonResponse({ success: false, message: "Mobile number is required." }, 400);
    }

    const attendeeType = (formData.get("attendeeType") as string) || "GENERAL";
    const businessName = (formData.get("businessName") as string) || "";
    const businessCategory = (formData.get("businessCategory") as string) || "";
    const otherCategory = (formData.get("otherCategory") as string) || "";
    const fullName = (formData.get("fullName") as string) || "";
    const email = (formData.get("email") as string) || "";
    const gender = (formData.get("gender") as string) || "";
    const address = (formData.get("address") as string) || "";
    const city = (formData.get("city") as string) || "";
    const state = (formData.get("state") as string) || "";
    const pincode = (formData.get("pincode") as string) || "";

    const rawAttendance = formData.get("attendance") as string;
    let attendanceArray: string[] = [];
    try {
      attendanceArray = JSON.parse(rawAttendance);
    } catch {
      attendanceArray = rawAttendance ? [rawAttendance] : [];
    }

    // 1. DATA VALIDATION
    const validationResult = formSchema.safeParse({
      fullName,
      mobile: mobile.trim(),
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
          message: validationResult.error.issues[0]?.message || "Please complete all fields.",
        },
        400
      );
    }

    const photoFile = formData.get("photo") as File | null;
    if (!photoFile || photoFile.size === 0) {
      return jsonResponse({ success: false, message: "Profile photo is required." }, 400);
    }

    // 2. PREPARE SECURE DATA
    const typeInitial = attendeeType.charAt(0).toUpperCase();
    const attendee_id = `TDE26-${typeInitial}-${generateCode(6)}`;
    const normalizedBusinessName = businessName.trim() || null;
    const normalizedBusinessCategory = businessCategory.trim() || null;
    let normalizedOtherCategory: string | null = otherCategory.trim() || null;

    if (normalizedBusinessCategory !== "OTHER" || !normalizedOtherCategory) {
      normalizedOtherCategory = null;
    }

    const chronologicalOrder: Record<string, number> = {
      "30 August": 1,
      "31 August": 2,
      "1 September": 3,
    };
    attendanceArray.sort((a, b) => (chronologicalOrder[a] || 99) - (chronologicalOrder[b] || 99));

    // 3. UPLOAD PHOTO
    const buffer = Buffer.from(await photoFile.arrayBuffer());
    const photoUrl = await uploadToCloudinary(buffer, mobile.trim());

    if (!photoUrl) {
      return jsonResponse(
        { success: false, message: "Network too slow. Photo upload timed out. Please try again." },
        502
      );
    }

    // 4. FAST SUPABASE INSERT
    const { error: insertError } = await supabase.from("attendees").insert([
      {
        attendee_id: attendee_id,
        full_name: fullName,
        mobile: mobile.trim(),
        email: email?.trim() || null,
        gender,
        attendee_type: attendeeType,
        business_name: normalizedBusinessName,
        business_category: normalizedBusinessCategory,
        other_category: normalizedOtherCategory,
        address,
        city,
        state,
        pincode,
        attendance_days: attendanceArray,
        photo_url: photoUrl,
        checkin_history: {},
        needs_local_sync: true, // Tell local clients to download
        needs_cloud_sync: false,
        needs_sheet_sync: true, // Tell system to send to Sheets
      },
    ]);

    if (insertError) {
      if (insertError.code === "23505") {
        return jsonResponse({ success: false, message: "You are already registered." }, 409);
      }
      throw new Error("Database error");
    }

    // 5. 🛡️ ROBUST GOOGLE SHEETS ATTEMPT (Non-blocking failure)
    try {
      const spreadsheetId = process.env.GOOGLE_SHEET_ID;
      if (spreadsheetId && process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
        const auth = new google.auth.GoogleAuth({
          credentials: {
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
          },
          scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });

        const sheets = google.sheets({ version: "v4", auth });

        const rowData = [
          attendee_id,
          fullName,
          mobile.trim(),
          email?.trim() || "N/A",
          gender,
          attendeeType,
          normalizedBusinessName || "N/A",
          normalizedBusinessCategory || "N/A",
          normalizedOtherCategory || "N/A",
          address,
          city,
          state,
          pincode,
          attendanceArray.join(", "),
          photoUrl,
          "Not Checked In",
          new Date().toISOString(),
        ];

        // Append to sheets
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: "Sheet1!A:Q",
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [rowData] },
        });

        // If successful, update the flag in Supabase so Admin Sync doesn't duplicate it
        await supabase
          .from("attendees")
          .update({ needs_sheet_sync: false })
          .eq("attendee_id", attendee_id);
      }
    } catch (sheetError) {
      console.warn("Direct Google Sheet sync failed. Deferred to Admin Sync.", sheetError);
    }

    // 6. INSTANT SUCCESS RETURN
    return jsonResponse(
      {
        success: true,
        attendeeId: attendee_id,
        message: "Registration successful! Pass generated.",
      },
      201
    );
  } catch (error: any) {
    console.error("Critical System Error:", error);
    return jsonResponse(
      { success: false, message: "An unexpected error occurred. Please try again." },
      500
    );
  }
}

// ---------------------------------------------------------
// 4. ADMIN STATS
// ---------------------------------------------------------
export async function getAdminStats() {
  try {
    const supabase = getSupabase();

    const { count: totalCount, error: totalError } = await supabase
      .from("attendees")
      .select("*", { count: "exact", head: true });

    const { count: pendingCount, error: pendingError } = await supabase
      .from("attendees")
      .select("*", { count: "exact", head: true })
      .eq("needs_sheet_sync", true);

    const { count: checkedInCount, error: checkedInError } = await supabase
      .from("attendees")
      .select("*", { count: "exact", head: true })
      .neq("checkin_history", "{}");

    if (totalError || pendingError || checkedInError) throw new Error("Failed to fetch counts");

    return jsonResponse(
      {
        success: true,
        total: totalCount || 0,
        pendingSync: pendingCount || 0,
        checkedIn: checkedInCount || 0,
      },
      200
    );
  } catch (error) {
    console.error("Stats Error:", error);
    return jsonResponse({ success: false, message: "Server error" }, 500);
  }
}

// ---------------------------------------------------------
// 5. ADMIN SYNC (UPSERT LOGIC)
// ---------------------------------------------------------
export async function postAdminSync() {
  try {
    const supabase = getSupabase();
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;

    if (!spreadsheetId) {
      return jsonResponse({ success: false, message: "Google Sheet ID is missing." }, 500);
    }

    // 1. Fetch exactly 100 records needing sync to prevent server timeout
    const { data: attendeesToSync, error: fetchError } = await supabase
      .from("attendees")
      .select("*")
      .eq("needs_sheet_sync", true)
      .limit(100);

    if (fetchError) {
      console.error("Supabase Fetch Error:", fetchError);
      return jsonResponse(
        { success: false, message: "Failed to fetch records from database." },
        500
      );
    }

    if (!attendeesToSync || attendeesToSync.length === 0) {
      return jsonResponse(
        { success: true, message: "Everything is up to date. No records to sync." },
        200
      );
    }

    // 2. Initialize Google Sheets API
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
      },
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    // 3. GET PRE-LOCATION OF USERS (Read Column A to find existing rows)
    const existingIdsResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A:A", // Fetch only Attendee IDs
    });

    const existingRows = existingIdsResponse.data.values || [];
    const rowIndexMap = new Map<string, number>();
    existingRows.forEach((row, index) => {
      if (row[0]) rowIndexMap.set(row[0].trim(), index + 1);
    });

    // 4. SORT DATA INTO 'UPDATES' AND 'APPENDS'
    const updateData: any[] = [];
    const appendData: any[] = [];
    const successfullyProcessedIds: string[] = [];

    attendeesToSync.forEach((attendee) => {
      // Format check-in history beautifully
      let checkinStatus = "Not Checked In";
      if (attendee.checkin_history && Object.keys(attendee.checkin_history).length > 0) {
        checkinStatus = Object.entries(attendee.checkin_history)
          .map(([date, details]: [string, any]) => `${date} (${details.source || "unknown"})`)
          .join(" | ");
      }

      // Exact row format matching Google Sheet Columns A to Q
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

    // 5. EXECUTE GOOGLE SHEETS API CALLS
    try {
      if (updateData.length > 0) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: {
            valueInputOption: "USER_ENTERED",
            data: updateData,
          },
        });
      }

      if (appendData.length > 0) {
        await sheets.spreadsheets.values.append({
          spreadsheetId,
          range: "Sheet1!A:Q",
          valueInputOption: "USER_ENTERED",
          requestBody: { values: appendData },
        });
      }
    } catch (sheetError) {
      console.error("Google Sheets API Error:", sheetError);
      return jsonResponse(
        { success: false, message: "Connected to database, but failed to write to Google Sheets." },
        502
      );
    }

    // 6. CLEAR FLAGS IN SUPABASE
    if (successfullyProcessedIds.length > 0) {
      const { error: updateError } = await supabase
        .from("attendees")
        .update({ needs_sheet_sync: false })
        .in("id", successfullyProcessedIds);

      if (updateError) {
        console.error("Supabase Flag Update Error:", updateError);
        return jsonResponse(
          {
            success: false,
            message: "Synced to sheets, but failed to clear sync flags. (Might cause repeat syncs)",
          },
          500
        );
      }
    }

    // 7. RETURN ROBUST SUCCESS
    return jsonResponse(
      {
        success: true,
        message: `Successfully synced ${successfullyProcessedIds.length} records (${updateData.length} updated, ${appendData.length} new).`,
      },
      200
    );
  } catch (error: any) {
    console.error("Critical Sync API Error:", error);
    return jsonResponse(
      { success: false, message: "An unexpected system error occurred during sync." },
      500
    );
  }
}

// ---------------------------------------------------------
// 6. ADMIN EXPORT
// ---------------------------------------------------------
const escapeSQL = (val: string | null | undefined) => {
  if (!val) return "NULL";
  return `'${val.replace(/'/g, "''")}'`;
};

const escapeCSV = (val: unknown) => {
  if (val === null || val === undefined) return '""';
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

// 🛡️ CRITICAL FIX: Use NextRequest and NextResponse for file exports
export async function getAdminExport(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const format = url.searchParams.get("format") || "csv";
    const supabase = getSupabase();

    const { data: attendees, error } = await supabase
      .from("attendees")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;
    if (!attendees || attendees.length === 0) {
      return new NextResponse("No data found", { status: 404 });
    }

    if (format === "sql") {
      let sqlString = `-- TDEUP SQLite3 Database Dump\n`;
      sqlString += `CREATE TABLE IF NOT EXISTS attendees (\n`;
      sqlString += `  id TEXT PRIMARY KEY,\n`;
      sqlString += `  attendee_id TEXT UNIQUE,\n`;
      sqlString += `  full_name TEXT,\n`;
      sqlString += `  mobile TEXT,\n`;
      sqlString += `  email TEXT,\n`;
      sqlString += `  gender TEXT,\n`;
      sqlString += `  attendee_type TEXT,\n`;
      sqlString += `  business_name TEXT,\n`;
      sqlString += `  business_category TEXT,\n`;
      sqlString += `  other_category TEXT,\n`;
      sqlString += `  address TEXT,\n`;
      sqlString += `  city TEXT,\n`;
      sqlString += `  state TEXT,\n`;
      sqlString += `  pincode TEXT,\n`;
      sqlString += `  attendance_days TEXT,\n`;
      sqlString += `  photo_url TEXT,\n`;
      sqlString += `  checkin_history TEXT,\n`;
      sqlString += `  needs_cloud_sync INTEGER,\n`;
      sqlString += `  needs_sheet_sync INTEGER,\n`;
      sqlString += `  created_at DATETIME\n`;
      sqlString += `);\n\n`;

      attendees.forEach((row) => {
        const days = Array.isArray(row.attendance_days)
          ? row.attendance_days.join(", ")
          : row.attendance_days;
        const historyStr = JSON.stringify(row.checkin_history || {});

        sqlString += `INSERT INTO attendees (id, attendee_id, full_name, mobile, email, gender, attendee_type, business_name, business_category, other_category, address, city, state, pincode, attendance_days, photo_url, checkin_history, needs_cloud_sync, needs_sheet_sync, created_at) VALUES (`;
        sqlString += `${escapeSQL(row.id)}, ${escapeSQL(row.attendee_id)}, ${escapeSQL(row.full_name)}, ${escapeSQL(row.mobile)}, ${escapeSQL(row.email)}, ${escapeSQL(row.gender)}, ${escapeSQL(row.attendee_type)}, ${escapeSQL(row.business_name)}, ${escapeSQL(row.business_category)}, ${escapeSQL(row.other_category)}, ${escapeSQL(row.address)}, ${escapeSQL(row.city)}, ${escapeSQL(row.state)}, ${escapeSQL(row.pincode)}, ${escapeSQL(days)}, ${escapeSQL(row.photo_url)}, ${escapeSQL(historyStr)}, ${row.needs_cloud_sync ? 1 : 0}, ${row.needs_sheet_sync ? 1 : 0}, ${escapeSQL(row.created_at)});\n`;
      });

      return new NextResponse(sqlString, {
        headers: {
          "Content-Type": "application/sql",
          "Content-Disposition": `attachment; filename="tdeup_export.sql"`,
        },
      });
    }

    const headers = Object.keys(attendees[0]);
    let csvString = headers.join(",") + "\n";

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
      csvString += values.join(",") + "\n";
    });

    return new NextResponse(csvString, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="tdeup_export.csv"`,
      },
    });
  } catch (error) {
    console.error("Export Error:", error);
    return new NextResponse("Failed to generate export", { status: 500 });
  }
}
