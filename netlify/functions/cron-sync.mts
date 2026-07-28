import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import type { Config } from "@netlify/functions";

// ---------------------------------------------------------
// Configuration & Cached Clients (Cold Start Optimization)
// ---------------------------------------------------------
// OPTIMIZATION: Initialize outside the handler so the CPU-heavy
// Google Auth decryption only happens once when the container starts.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase environment variables.");
}
const supabase = createClient(supabaseUrl, supabaseKey);

const auth = new google.auth.GoogleAuth({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// ---------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------
/**
 * Converts `checkin_history` JSONB into a readable status string for Google Sheets.
 * Examples:
 * - {} -> "Not Checked In"
 * - {"30 August": "10:15 AM"} -> "Checked In (30 August: 10:15 AM)"
 */
function formatCheckInStatus(checkinHistory: any): string {
  if (
    !checkinHistory ||
    typeof checkinHistory !== "object" ||
    Object.keys(checkinHistory).length === 0
  ) {
    return "Not Checked In";
  }

  const entries = Object.entries(checkinHistory);
  if (entries.length === 0) return "Not Checked In";

  const formatted = entries
    .map(([day, time]) =>
      typeof time === "string"
        ? `${day}: ${time}`
        : typeof time === "boolean" && time
          ? `${day}`
          : `${day}: ${JSON.stringify(time)}`
    )
    .join(", ");

  return `Checked In (${formatted})`;
}

// ---------------------------------------------------------
// Main Handler (Triggered by Netlify Scheduled Functions)
// ---------------------------------------------------------
export default async function handler(req: Request) {
  // NOTE: Unlike Vercel, Netlify natively secures scheduled functions.
  // We removed the CRON_SECRET authorization check because Netlify's internal
  // scheduler does not send custom Bearer tokens.

  try {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;

    if (!spreadsheetId) {
      throw new Error("Missing GOOGLE_SHEET_ID variable.");
    }

    // 1. FETCH RECORDS
    // Processing max 500 at a time to stay within Netlify's execution limits
    const BATCH_SIZE = 500;
    const { data: attendees, error: fetchError } = await supabase
      .from("attendees")
      .select("*")
      .eq("needs_sheet_sync", true)
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (fetchError) {
      console.error("Supabase Fetch Error:", fetchError);
      return new Response(JSON.stringify({ success: false, message: "DB Fetch Error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!attendees || attendees.length === 0) {
      return new Response(
        JSON.stringify({
          success: true,
          message: "Everything up to date. No records pending sync.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. FETCH ALL EXISTING ATTENDEE IDs FROM GOOGLE SHEET (Column A)
    const sheetMap = new Map<string, number>();
    let currentTotalRows = 0;

    try {
      const existingRowsRes = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: "Sheet1!A:A",
      });

      const existingRows = existingRowsRes.data.values || [];
      currentTotalRows = existingRows.length;

      existingRows.forEach((row, index) => {
        if (row[0]) {
          // Google Sheets uses 1-based indexing (Row 1, Row 2, etc.)
          sheetMap.set(String(row[0]).trim(), index + 1);
        }
      });
    } catch (readError) {
      console.error("Error reading existing Google Sheet rows:", readError);
      throw readError;
    }

    // 3. PREPARE BATCH UPDATES
    const valueDataUpdates: { range: string; values: any[][] }[] = [];

    for (const user of attendees) {
      const checkInStatus = formatCheckInStatus(user.checkin_history);

      const rowData = [
        user.attendee_id,
        user.full_name,
        user.mobile,
        user.email || "N/A",
        user.gender,
        user.attendee_type,
        user.business_name || "N/A",
        user.business_category || "N/A",
        user.other_category || "N/A",
        user.address,
        user.city,
        user.state,
        user.pincode,
        Array.isArray(user.attendance_days) ? user.attendance_days.join(", ") : "N/A",
        user.photo_url,
        checkInStatus,
        user.created_at,
      ];

      let targetRow = sheetMap.get(user.attendee_id);

      if (targetRow) {
        // UPDATE EXISTING ROW (Prevents duplication!)
        valueDataUpdates.push({
          range: `Sheet1!A${targetRow}:Q${targetRow}`,
          values: [rowData],
        });
      } else {
        // INSERT NEW ROW AT END OF SHEET
        currentTotalRows += 1;
        targetRow = currentTotalRows;
        sheetMap.set(user.attendee_id, targetRow); // Map it in case duplicate appears in same batch

        valueDataUpdates.push({
          range: `Sheet1!A${targetRow}:Q${targetRow}`,
          values: [rowData],
        });
      }
    }

    // 4. Perform BATCH UPDATE in ONE Google Sheets API call
    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: valueDataUpdates,
        },
      });
    } catch (sheetError) {
      console.error("Google Sheets Batch Update Error:", sheetError);
      // Abort so `needs_sheet_sync` remains true and the next cron cycle retries them.
      return new Response(JSON.stringify({ success: false, message: "Google API Error" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 5. Clear `needs_sheet_sync` flag in Supabase
    const syncedIds = attendees.map((a) => a.attendee_id);
    const { error: updateError } = await supabase
      .from("attendees")
      .update({ needs_sheet_sync: false })
      .in("attendee_id", syncedIds);

    if (updateError) {
      console.error("Supabase Flag Reset Error:", updateError);
      return new Response(JSON.stringify({ success: false, message: "Flag Reset Error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Cron completed successfully. Processed ${attendees.length} attendees/updates.`,
        totalProcessed: attendees.length,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("Fatal Cron Job Error:", error);
    return new Response(
      JSON.stringify({ success: false, message: "Internal Server Error during cron execution." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

// ---------------------------------------------------------
// Netlify Scheduled Function Config (V2 syntax)
// ---------------------------------------------------------
// UTC 21:00 equates to IST 02:30 AM (the following day)
export const config: Config = {
  schedule: "0 21 * * *",
};
