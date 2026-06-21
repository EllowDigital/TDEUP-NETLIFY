import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import { v2 as cloudinary } from "cloudinary";

import { formSchema } from "./schema";

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
            if (result) {
              resolve(result.secure_url);
            } else {
              reject(error);
            }
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

export async function postFindPass(req: Request) {
  try {
    const { mobile } = await req.json();

    if (!mobile) {
      return jsonResponse({ success: false, message: "Mobile number required." }, 400);
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

export async function postCheckIn(req: Request) {
  try {
    const { attendee_id } = await req.json();

    if (!attendee_id) {
      return jsonResponse({ success: false, message: "Attendee ID required." }, 400);
    }

    const supabase = getSupabase();
    const { data: user, error: fetchError } = await supabase
      .from("attendees")
      .select("checked_in, full_name")
      .eq("attendee_id", attendee_id)
      .maybeSingle();

    if (fetchError || !user) {
      return jsonResponse({ success: false, message: "Invalid Pass. Attendee not found." }, 404);
    }

    if (user.checked_in) {
      return jsonResponse(
        { success: false, message: `${user.full_name} is already checked in.` },
        409
      );
    }

    const { error: updateError } = await supabase
      .from("attendees")
      .update({ checked_in: true })
      .eq("attendee_id", attendee_id);

    if (updateError) throw updateError;

    return jsonResponse(
      { success: true, message: `Successfully checked in ${user.full_name}!` },
      200
    );
  } catch (error) {
    console.error("Check-in Error:", error);
    return jsonResponse({ success: false, message: "Server error" }, 500);
  }
}

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
          message:
            validationResult.error.issues[0]?.message ||
            "Please complete all required fields before submitting.",
        },
        400
      );
    }

    const photoFile = formData.get("photo") as File | null;
    if (!photoFile || photoFile.size === 0) {
      return jsonResponse(
        {
          success: false,
          message: "Profile photo is required before registration can be saved.",
        },
        400
      );
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
      return jsonResponse(
        {
          success: false,
          message: "We could not upload your photo. Please try again with a clear image.",
        },
        502
      );
    }

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
        checked_in: null,
        needs_sync: true,
      },
    ]);

    if (insertError) {
      if (insertError.code === "23505") {
        return jsonResponse(
          { success: false, message: "You are already registered with this mobile number." },
          409
        );
      }

      console.error("Supabase Insert Error:", insertError);
      return jsonResponse(
        { success: false, message: "Failed to save registration data to our servers." },
        500
      );
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
        "FALSE",
        new Date().toISOString(),
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "Sheet1!A:Q",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [rowData] },
      });

      await supabase.from("attendees").update({ needs_sync: false }).eq("mobile", mobile.trim());
    } catch (sheetError) {
      console.error(
        `Google Sheets sync failed for ${mobile}, but data is safe in Supabase.`,
        sheetError
      );
    }

    return jsonResponse(
      {
        success: true,
        attendeeId: attendee_id,
        message: "Registration successful!",
      },
      201
    );
  } catch (error: any) {
    console.error("Critical Submission Error:", error);
    return jsonResponse(
      { success: false, message: error.message || "An unexpected system error occurred." },
      500
    );
  }
}

export async function getAdminStats() {
  try {
    const supabase = getSupabase();

    const { count: totalCount, error: totalError } = await supabase
      .from("attendees")
      .select("*", { count: "exact", head: true });

    const { count: pendingCount, error: pendingError } = await supabase
      .from("attendees")
      .select("*", { count: "exact", head: true })
      .eq("needs_sync", true);

    if (totalError || pendingError) throw new Error("Failed to fetch counts");

    return jsonResponse({ total: totalCount || 0, pendingSync: pendingCount || 0 }, 200);
  } catch (error) {
    console.error("Stats Error:", error);
    return jsonResponse({ success: false, message: "Server error" }, 500);
  }
}

export async function postAdminSync() {
  try {
    const supabase = getSupabase();

    const { data: unsynced, error: fetchError } = await supabase
      .from("attendees")
      .select("*")
      .eq("needs_sync", true);

    if (fetchError) throw fetchError;

    if (!unsynced || unsynced.length === 0) {
      return jsonResponse(
        { success: true, message: "Google Sheets is already completely up to date!" },
        200
      );
    }

    const rowsToAppend = unsynced.map((row) => {
      const days = Array.isArray(row.attendance_days)
        ? row.attendance_days.join(", ")
        : row.attendance_days;

      return [
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
        row.checked_in ? "TRUE" : "FALSE",
        row.created_at,
      ];
    });

    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Sheet1!A:Q",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rowsToAppend },
    });

    const syncedIds = unsynced.map((item) => item.id);
    const { error: updateError } = await supabase
      .from("attendees")
      .update({ needs_sync: false })
      .in("id", syncedIds);

    if (updateError) throw updateError;

    return jsonResponse(
      {
        success: true,
        message: `Successfully synced ${unsynced.length} records to Google Sheets!`,
      },
      200
    );
  } catch (error) {
    console.error("Sync Error:", error);
    return jsonResponse(
      { success: false, message: "Failed to communicate with Google Sheets." },
      500
    );
  }
}

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
      sqlString += `  id INTEGER PRIMARY KEY AUTOINCREMENT,\n`;
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
      sqlString += `  checked_in BOOLEAN,\n`;
      sqlString += `  created_at DATETIME\n`;
      sqlString += `);\n\n`;

      attendees.forEach((row) => {
        const days = Array.isArray(row.attendance_days)
          ? row.attendance_days.join(", ")
          : row.attendance_days;

        sqlString +=
          `INSERT INTO attendees (attendee_id, full_name, mobile, email, gender, attendee_type, business_name, business_category, other_category, address, city, state, pincode, attendance_days, photo_url, checked_in, created_at) VALUES (` +
          `${escapeSQL(row.attendee_id)}, ${escapeSQL(row.full_name)}, ${escapeSQL(row.mobile)}, ${escapeSQL(row.email)}, ${escapeSQL(row.gender)}, ${escapeSQL(row.attendee_type)}, ${escapeSQL(row.business_name)}, ${escapeSQL(row.business_category)}, ${escapeSQL(row.other_category)}, ${escapeSQL(row.address)}, ${escapeSQL(row.city)}, ${escapeSQL(row.state)}, ${escapeSQL(row.pincode)}, ${escapeSQL(days)}, ${escapeSQL(row.photo_url)}, ${row.checked_in ? 1 : 0}, ${escapeSQL(row.created_at)});\n`;
      });

      return new Response(sqlString, {
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
        let value = row[header];
        if (Array.isArray(value)) value = value.join(", ");
        return escapeCSV(value);
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
