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
function generateCode(length = 6) {
  let code = "";
  for (let index = 0; index < length; index++) {
    code += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return code;
}

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
            timeout: 20000,
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
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  return null;
}

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

// ---------------------------------------------------------
// 1. FIND PASS
// ---------------------------------------------------------
export async function postFindPass(req: Request) {
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
      return jsonResponse({ success: false, message: "No pass found for this mobile number." }, 404);
    }

    return jsonResponse({ success: true, attendee: data }, 200);
  } catch (error) {
    console.error("Find Pass Error:", error);
    return jsonResponse({ success: false, message: "Server error" }, 500);
  }
}

// ---------------------------------------------------------
// 2. CHECK IN (Multi-Day Logic)
// ---------------------------------------------------------
export async function postCheckIn(req: Request) {
  try {
    const { attendee_id, device_name = "Online Scanner", station_name = "Web Hub" } = await req.json();

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

    // 2. Determine "Today's Date" in IST
    const dateIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    let todayKey = `${dateIST.getDate()} ${monthNames[dateIST.getMonth()]}`;

    // --- TESTING OVERRIDE: Uncomment the next line to test as if today is the event day ---
    // todayKey = "30 August";

    // 3. Validate Date (Does the user have a pass for today?)
    const attendanceDays: string[] = user.attendance_days || [];
    const cleanDays = attendanceDays.map(d => d.replace(" 2026", "").trim());

    if (!attendanceDays.includes(todayKey) && !cleanDays.includes(todayKey)) {
      return jsonResponse(
        { success: false, message: `Access Denied: ${user.full_name} does not have a pass for today (${todayKey}).` },
        403
      );
    }

    // 4. Validate Duplicate Check-in (Are they already checked in today?)
    const history = user.checkin_history || {};
    if (history[todayKey] || history[`${todayKey} 2026`]) {
      return jsonResponse(
        { success: false, message: `${user.full_name} is already checked in for today.` },
        409
      );
    }

    // 5. Update Check-in History (Nested JSON)
    const timestampNow = new Date().toISOString();
    history[todayKey] = {
      timestamp: timestampNow,
      device: device_name,
      station: station_name
    };

    // 6. Save to Database
    const { error: updateError } = await supabase
      .from("attendees")
      .update({ 
        checkin_history: history, 
        needs_sheet_sync: true // Mark for Google Sheets sync
      })
      .eq("attendee_id", attendee_id);

    if (updateError) throw updateError;

    return jsonResponse(
      { success: true, message: `Access Granted for ${todayKey}! Welcome ${user.full_name}!` },
      200
    );
  } catch (error) {
    console.error("Check-in Error:", error);
    return jsonResponse({ success: false, message: "Server error" }, 500);
  }
}

// ---------------------------------------------------------
// 3. REGISTER
// ---------------------------------------------------------
export async function postRegister(req: Request) {
  try {
    const supabase = getSupabase();
    const formData = await req.formData();
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
          message: validationResult.error.issues[0]?.message || "Please complete all required fields.",
        },
        400
      );
    }

    const photoFile = formData.get("photo") as File | null;
    if (!photoFile || photoFile.size === 0) {
      return jsonResponse({ success: false, message: "Profile photo is required." }, 400);
    }

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

    const buffer = Buffer.from(await photoFile.arrayBuffer());
    const photoUrl = await uploadToCloudinary(buffer, mobile.trim());

    if (!photoUrl) {
      return jsonResponse({ success: false, message: "Photo upload failed. Try again." }, 502);
    }

    // Insert with NEW Schema
    const { error: insertError } = await supabase.from("attendees").insert([
      {
        attendee_id,
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
        checkin_history: {},     // Start empty
        needs_cloud_sync: false, // Already online
        needs_sheet_sync: true,  // Send to Sheets
      },
    ]);

    if (insertError) {
      if (insertError.code === "23505") {
        return jsonResponse({ success: false, message: "Mobile number already registered." }, 409);
      }
      return jsonResponse({ success: false, message: "Database save failed." }, 500);
    }

    try {
      const spreadsheetId = process.env.GOOGLE_SHEET_ID;
      const rowData = [
        attendee_id,
        fullName,
        mobile.trim(),
        email || "N/A",
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
        photoUrl || "N/A",
        "Not Checked In", // New string format for sheets
        new Date().toISOString(),
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "Sheet1!A:Q",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [rowData] },
      });

      await supabase.from("attendees").update({ needs_sheet_sync: false }).eq("mobile", mobile.trim());
    } catch (sheetError) {
      console.error(`Google Sheets sync failed for ${mobile}`, sheetError);
    }

    return jsonResponse({ success: true, attendeeId: attendee_id, message: "Registration successful!" }, 201);
  } catch (error: any) {
    console.error("Submission Error:", error);
    return jsonResponse({ success: false, message: error.message || "An unexpected error occurred." }, 500);
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
      
    // Count anyone whose checkin_history is NOT an empty JSON object
    const { count: checkedInCount, error: checkedInError } = await supabase
      .from("attendees")
      .select("*", { count: "exact", head: true })
      .neq("checkin_history", "{}");

    if (totalError || pendingError || checkedInError) throw new Error("Failed to fetch counts");

    return jsonResponse({ 
      success: true,
      total: totalCount || 0, 
      pendingSync: pendingCount || 0,
      checkedIn: checkedInCount || 0
    }, 200);
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

    const { data: unsynced, error: fetchError } = await supabase
      .from("attendees")
      .select("*")
      .eq("needs_sheet_sync", true);

    if (fetchError) throw fetchError;

    if (!unsynced || unsynced.length === 0) {
      return jsonResponse({ success: true, message: "Google Sheets is already up to date!" }, 200);
    }

    const sheetData = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Sheet1!A:A", 
    });
    
    const existingIds = sheetData.data.values || [];
    const rowMap = new Map<string, number>();
    existingIds.forEach((row, index) => {
      if (row[0]) rowMap.set(row[0], index + 1);
    });

    const rowsToAppend: any[][] = [];
    const rowsToUpdate: any[] = [];

    unsynced.forEach((row) => {
      const days = Array.isArray(row.attendance_days) ? row.attendance_days.join(", ") : row.attendance_days;

      // Extract days attended from JSON keys
      const historyKeys = Object.keys(row.checkin_history || {});
      const finalCheckinStatus = historyKeys.length > 0 ? historyKeys.join(", ") : "Not Checked In";

      const rowData = [
        row.attendee_id,
        row.full_name,
        row.mobile,
        row.email || "N/A",
        row.gender,
        row.attendee_type,
        row.business_name || "N/A",
        row.business_category || "N/A",
        row.other_category || "N/A",
        row.address,
        row.city,
        row.state,
        row.pincode,
        days,
        row.photo_url || "N/A",
        finalCheckinStatus, 
        row.created_at,
      ];

      if (rowMap.has(row.attendee_id)) {
        const rowNum = rowMap.get(row.attendee_id);
        rowsToUpdate.push({ range: `Sheet1!A${rowNum}:Q${rowNum}`, values: [rowData] });
      } else {
        rowsToAppend.push(rowData);
      }
    });

    if (rowsToUpdate.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: "USER_ENTERED", data: rowsToUpdate },
      });
    }

    if (rowsToAppend.length > 0) {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "Sheet1!A:Q",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: rowsToAppend },
      });
    }

    const syncedIds = unsynced.map((item) => item.id);
    const { error: updateError } = await supabase
      .from("attendees")
      .update({ needs_sheet_sync: false })
      .in("id", syncedIds);

    if (updateError) throw updateError;

    return jsonResponse({ success: true, message: `Updated ${rowsToUpdate.length} rows, Appended ${rowsToAppend.length} rows.` }, 200);
  } catch (error) {
    console.error("Sync Error:", error);
    return jsonResponse({ success: false, message: "Failed to communicate with Google Sheets." }, 500);
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

export async function getAdminExport(req: Request) {
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
      return new Response("No data found", { status: 404 });
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
        const days = Array.isArray(row.attendance_days) ? row.attendance_days.join(", ") : row.attendance_days;
        const historyStr = JSON.stringify(row.checkin_history || {});

        sqlString += `INSERT INTO attendees (id, attendee_id, full_name, mobile, email, gender, attendee_type, business_name, business_category, other_category, address, city, state, pincode, attendance_days, photo_url, checkin_history, needs_cloud_sync, needs_sheet_sync, created_at) VALUES (`;
        sqlString += `${escapeSQL(row.id)}, ${escapeSQL(row.attendee_id)}, ${escapeSQL(row.full_name)}, ${escapeSQL(row.mobile)}, ${escapeSQL(row.email)}, ${escapeSQL(row.gender)}, ${escapeSQL(row.attendee_type)}, ${escapeSQL(row.business_name)}, ${escapeSQL(row.business_category)}, ${escapeSQL(row.other_category)}, ${escapeSQL(row.address)}, ${escapeSQL(row.city)}, ${escapeSQL(row.state)}, ${escapeSQL(row.pincode)}, ${escapeSQL(days)}, ${escapeSQL(row.photo_url)}, ${escapeSQL(historyStr)}, ${row.needs_cloud_sync ? 1 : 0}, ${row.needs_sheet_sync ? 1 : 0}, ${escapeSQL(row.created_at)});\n`;
      });

      return new Response(sqlString, {
        headers: {
          "Content-Type": "application/sql",
          "Content-Disposition": `attachment; filename="tdeup_export.sql"`,
        },
      });
    }

    // CSV Format
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

    return new Response(csvString, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="tdeup_export.csv"`,
      },
    });
  } catch (error) {
    console.error("Export Error:", error);
    return new Response("Failed to generate export", { status: 500 });
  }
}