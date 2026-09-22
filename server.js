const express = require("express");
const path = require("path");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT || 3000);

const SUPABASE_URL = process.env.SUPABASE_URL;

const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY;

const SUPABASE_SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !SUPABASE_SECRET_KEY) {
  console.error("Missing Supabase environment variables.");
  process.exit(1);
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  }
);

const admin = createClient(
  SUPABASE_URL,
  SUPABASE_SECRET_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false
    }
  }
);

const PUBLIC_DIR = path.join(__dirname, "..", "public");

app.use(express.json({ limit: "1mb" }));

app.use(express.static(PUBLIC_DIR));

/* =========================================================
   CONSTANTS
========================================================= */

const UP_CENTER = {
  lat: 19.02843,
  lng: 99.89624
};

const MATCH_PICKUP_KM = 4;
const MATCH_DESTINATION_KM = 6;
const MATCH_SCORE_KM = 7;

const NOMINATIM_URL =
  "https://nominatim.openstreetmap.org";

const OSRM_URL =
  "https://router.project-osrm.org";

/* =========================================================
   BASIC HELPERS
========================================================= */

function cleanText(value) {
  return String(value || "").trim();
}

function validCoordinate(lat, lng) {
  return (
    Number.isFinite(Number(lat)) &&
    Number.isFinite(Number(lng)) &&
    Number(lat) >= -90 &&
    Number(lat) <= 90 &&
    Number(lng) >= -180 &&
    Number(lng) <= 180
  );
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;

  const dLat =
    ((lat2 - lat1) * Math.PI) / 180;

  const dLng =
    ((lng2 - lng1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;

  return (
    R *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

function routeMatch(a, b) {
  const pickupKm = haversineKm(
    a.origin_lat,
    a.origin_lng,
    b.origin_lat,
    b.origin_lng
  );

  const destinationKm = haversineKm(
    a.destination_lat,
    a.destination_lng,
    b.destination_lat,
    b.destination_lng
  );

  const score =
    pickupKm * 0.55 +
    destinationKm * 0.45;

  const campusDistance = Math.min(
    haversineKm(
      a.origin_lat,
      a.origin_lng,
      UP_CENTER.lat,
      UP_CENTER.lng
    ),
    haversineKm(
      a.destination_lat,
      a.destination_lng,
      UP_CENTER.lat,
      UP_CENTER.lng
    )
  );

  return {
    pickupKm,
    destinationKm,
    score,
    campusDistance,
    matched:
      pickupKm <= MATCH_PICKUP_KM &&
      destinationKm <= MATCH_DESTINATION_KM &&
      score <= MATCH_SCORE_KM
  };
}

function statusLabel(status) {
  const labels = {
    searching: "กำลังค้นหา",
    matched: "จับคู่แล้ว",
    forming: "กำลังรวมกลุ่ม",
    sent_to_driver: "ส่งงานให้คนขับแล้ว",
    accepted: "คนขับรับงานแล้ว",
    completed: "เดินทางเสร็จแล้ว",
    cancelled: "ยกเลิก"
  };

  return labels[status] || status;
}

/* =========================================================
   AUTH
========================================================= */

async function getProfile(userId) {
  const { data, error } = await admin
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "กรุณาเข้าสู่ระบบ"
      });
    }

    const token = header.substring(7);

    const {
      data,
      error
    } = await admin.auth.getUser(token);

    if (error || !data.user) {
      return res.status(401).json({
        error: "Session หมดอายุ กรุณาเข้าสู่ระบบใหม่"
      });
    }

    req.user = data.user;

    req.profile = await getProfile(
      data.user.id
    );

    next();
  } catch (error) {
    console.error(error);

    return res.status(401).json({
      error: "ไม่สามารถตรวจสอบผู้ใช้ได้"
    });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.profile || req.profile.role !== role) {
      return res.status(403).json({
        error: "ไม่มีสิทธิ์ใช้งานส่วนนี้"
      });
    }

    next();
  };
}

/* =========================================================
   GEOCODING
========================================================= */

async function geocode(text) {
  const query = cleanText(text);

  if (!query) {
    return null;
  }

  const url = new URL(
    `${NOMINATIM_URL}/search`
  );

  url.searchParams.set(
    "q",
    `${query}, Thailand`
  );

  url.searchParams.set(
    "format",
    "jsonv2"
  );

  url.searchParams.set(
    "limit",
    "1"
  );

  url.searchParams.set(
    "countrycodes",
    "th"
  );

  const response = await fetch(
    url,
    {
      headers: {
        "User-Agent":
          "UP-Drive/2.0 local university carpool project"
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      "ไม่สามารถค้นหาพิกัดสถานที่ได้"
    );
  }

  const results = await response.json();

  if (!results.length) {
    return null;
  }

  return {
    lat: Number(results[0].lat),
    lng: Number(results[0].lon),
    displayName:
      results[0].display_name
  };
}

async function reverseGeocode(lat, lng) {
  const url = new URL(
    `${NOMINATIM_URL}/reverse`
  );

  url.searchParams.set(
    "lat",
    String(lat)
  );

  url.searchParams.set(
    "lon",
    String(lng)
  );

  url.searchParams.set(
    "format",
    "jsonv2"
  );

  url.searchParams.set(
    "zoom",
    "18"
  );

  const response = await fetch(
    url,
    {
      headers: {
        "User-Agent":
          "UP-Drive/2.0 local university carpool project"
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      "ไม่สามารถอ่านตำแหน่งปัจจุบันได้"
    );
  }

  const data = await response.json();

  return {
    lat,
    lng,
    displayName:
      data.display_name ||
      `${lat.toFixed(6)}, ${lng.toFixed(6)}`
  };
}

/* =========================================================
   ROUTING
========================================================= */

async function calculateRoute(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return null;
  }

  const coordinates = points
    .map(
      (p) =>
        `${p.lng},${p.lat}`
    )
    .join(";");

  const url =
    `${OSRM_URL}/route/v1/driving/` +
    coordinates +
    "?overview=full&geometries=geojson&steps=false";

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      "ไม่สามารถคำนวณเส้นทางได้"
    );
  }

  const data = await response.json();

  if (
    data.code !== "Ok" ||
    !data.routes ||
    !data.routes.length
  ) {
    return null;
  }

  const route = data.routes[0];

  return {
    distance_meters:
      route.distance,

    duration_seconds:
      route.duration,

    geometry:
      route.geometry
  };
}

/* =========================================================
   GROUP
========================================================= */

async function getRawGroup(groupId) {
  const { data, error } = await admin
    .from("ride_groups")
    .select("*")
    .eq("id", groupId)
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

async function getGroupDetails(groupId) {
  const group =
    await getRawGroup(groupId);

  const {
    data: members,
    error: memberError
  } = await admin
    .from("ride_group_members")
    .select("*")
    .eq("group_id", groupId)
    .order("joined_at", {
      ascending: true
    });

  if (memberError) {
    throw new Error(
      memberError.message
    );
  }

  const requestIds = [
    ...new Set(
      members.map(
        (m) => m.ride_request_id
      )
    )
  ];

  const profileIds = [
    ...new Set([
      ...members.map(
        (m) => m.passenger_id
      ),
      group.driver_id
    ].filter(Boolean))
  ];

  let requests = [];
  let profiles = [];

  if (requestIds.length) {
    const result = await admin
      .from("ride_requests")
      .select("*")
      .in("id", requestIds);

    if (result.error) {
      throw new Error(
        result.error.message
      );
    }

    requests = result.data || [];
  }

  if (profileIds.length) {
    const result = await admin
      .from("profiles")
      .select(
        "id,name,phone,role,vehicle_seats"
      )
      .in("id", profileIds);

    if (result.error) {
      throw new Error(
        result.error.message
      );
    }

    profiles = result.data || [];
  }

  const requestMap =
    new Map(
      requests.map((r) => [
        r.id,
        r
      ])
    );

  const profileMap =
    new Map(
      profiles.map((p) => [
        p.id,
        p
      ])
    );

  const formattedMembers =
    members.map((member) => {
      const ride =
        requestMap.get(
          member.ride_request_id
        );

      const profile =
        profileMap.get(
          member.passenger_id
        );

      return {
        ...member,
        passenger: profile || null,
        ride: ride || null
      };
    });

  const actualPassengers =
    formattedMembers.reduce(
      (sum, member) =>
        sum +
        Number(
          member.party_size || 1
        ),
      0
    );

  const allConfirmed =
    formattedMembers.length > 0 &&
    formattedMembers.every(
      (member) =>
        member.confirmed === true
    );

  let route = null;

  const {
    data: routeData
  } = await admin
    .from("ride_routes")
    .select("*")
    .eq("group_id", groupId)
    .maybeSingle();

  route = routeData;

  return {
    ...group,

    status_label:
      statusLabel(group.status),

    actual_passengers:
      actualPassengers,

    all_confirmed:
      allConfirmed,

    driver:
      group.driver_id
        ? profileMap.get(
            group.driver_id
          ) || null
        : null,

    members:
      formattedMembers,

    route
  };
}

/* =========================================================
   MATCHING
========================================================= */

async function createGroupForRide(ride) {
  const {
    data: group,
    error: groupError
  } = await admin
    .from("ride_groups")
    .insert({
      leader_id:
        ride.passenger_id,

      target_passengers:
        ride.target_passengers,

      status: "forming"
    })
    .select()
    .single();

  if (groupError) {
    throw new Error(
      groupError.message
    );
  }

  const {
    error: memberError
  } = await admin
    .from("ride_group_members")
    .insert({
      group_id: group.id,

      ride_request_id:
        ride.id,

      passenger_id:
        ride.passenger_id,

      party_size: 1,

      confirmed: false
    });

  if (memberError) {
    await admin
      .from("ride_groups")
      .delete()
      .eq("id", group.id);

    throw new Error(
      memberError.message
    );
  }

  await admin
    .from("ride_requests")
    .update({
      group_id: group.id,
      status: "matched"
    })
    .eq("id", ride.id);

  return group.id;
}

async function joinExistingGroup(
  ride,
  group
) {
  const {
    data: existingMembers
  } = await admin
    .from("ride_group_members")
    .select(
      "party_size,confirmed"
    )
    .eq("group_id", group.id);

  const currentPassengers =
    (existingMembers || []).reduce(
      (sum, m) =>
        sum +
        Number(
          m.party_size || 1
        ),
      0
    );

  const newTarget = Math.max(
    group.target_passengers,
    ride.target_passengers
  );

  if (
    currentPassengers >=
    newTarget
  ) {
    return false;
  }

  const {
    error: memberError
  } = await admin
    .from("ride_group_members")
    .insert({
      group_id: group.id,

      ride_request_id:
        ride.id,

      passenger_id:
        ride.passenger_id,

      party_size: 1,

      confirmed: false
    });

  if (memberError) {
    return false;
  }

  await admin
    .from("ride_groups")
    .update({
      target_passengers:
        newTarget,

      status: "forming",

      confirmed_at: null
    })
    .eq("id", group.id);

  /*
   * มีสมาชิกใหม่เข้ากลุ่ม
   * ต้องให้ทุกคนยืนยันใหม่
   */

  await admin
    .from("ride_group_members")
    .update({
      confirmed: false
    })
    .eq("group_id", group.id);

  await admin
    .from("ride_requests")
    .update({
      group_id: group.id,
      status: "matched"
    })
    .eq("id", ride.id);

  return true;
}

async function findOrCreateGroup(
  ride
) {
  const {
    data: candidates,
    error
  } = await admin
    .from("ride_requests")
    .select("*")
    .in("status", [
      "searching",
      "matched"
    ])
    .neq("id", ride.id)
    .order("created_at", {
      ascending: true
    })
    .limit(100);

  if (error) {
    throw new Error(
      error.message
    );
  }

  let bestCandidate = null;
  let bestScore = Infinity;

  for (
    const candidate of candidates || []
  ) {
    let group = null;

    if (candidate.group_id) {
      try {
        group =
          await getRawGroup(
            candidate.group_id
          );
      } catch {
        continue;
      }

      if (
        group.status !==
        "forming"
      ) {
        continue;
      }
    }

    const match =
      routeMatch(
        ride,
        candidate
      );

    if (!match.matched) {
      continue;
    }

    /*
     * ถ้าอยู่ใกล้มหาวิทยาลัยพะเยา
     * ให้คะแนนดีขึ้น
     */

    let score =
      match.score;

    if (
      match.campusDistance <=
      15
    ) {
      score -= 0.5;
    }

    if (score < bestScore) {
      bestScore = score;

      bestCandidate = {
        candidate,
        group,
        match
      };
    }
  }

  if (!bestCandidate) {
    return createGroupForRide(
      ride
    );
  }

  /*
   * Candidate ยังไม่มีกลุ่ม
   */

  if (!bestCandidate.group) {
    const candidateGroupId =
      await createGroupForRide(
        bestCandidate.candidate
      );

    bestCandidate.group =
      await getRawGroup(
        candidateGroupId
      );
  }

  const joined =
    await joinExistingGroup(
      ride,
      bestCandidate.group
    );

  if (!joined) {
    return createGroupForRide(
      ride
    );
  }

  return bestCandidate.group.id;
}

/* =========================================================
   BUILD GROUP ROUTE
========================================================= */

async function rebuildGroupRoute(
  groupId
) {
  const details =
    await getGroupDetails(
      groupId
    );

  const points = [];

  /*
   * รับผู้โดยสารตามลำดับที่เข้ากลุ่ม
   */

  for (
    const member of details.members
  ) {
    if (!member.ride) {
      continue;
    }

    points.push({
      lat:
        member.ride.origin_lat,

      lng:
        member.ride.origin_lng
    });
  }

  /*
   * ใช้ปลายทางของสมาชิกคนแรก
   * เป็นปลายทางหลักของกลุ่ม
   */

  const first =
    details.members.find(
      (m) => m.ride
    );

  if (
    first &&
    first.ride
  ) {
    points.push({
      lat:
        first.ride.destination_lat,

      lng:
        first.ride.destination_lng
    });
  }

  if (points.length < 2) {
    return null;
  }

  const route =
    await calculateRoute(
      points
    );

  if (!route) {
    return null;
  }

  const {
    data,
    error
  } = await admin
    .from("ride_routes")
    .upsert(
      {
        group_id: groupId,

        distance_meters:
          route.distance_meters,

        duration_seconds:
          route.duration_seconds,

        geometry:
          route.geometry
      },
      {
        onConflict:
          "group_id"
      }
    )
    .select()
    .single();

  if (error) {
    throw new Error(
      error.message
    );
  }

  return data;
}

/* =========================================================
   AUTH REGISTER
========================================================= */

app.post(
  "/api/auth/register",
  async (req, res) => {
    try {
      const {
        name,
        email,
        phone,
        password,
        role,
        vehicleSeats
      } = req.body;

      const cleanName =
        cleanText(name);

      const cleanEmail =
        cleanText(email).toLowerCase();

      const cleanPhone =
        cleanText(phone);

      if (
        !cleanName ||
        !cleanEmail ||
        !password
      ) {
        return res.status(400).json({
          error:
            "กรุณากรอกข้อมูลให้ครบ"
        });
      }

      if (
        ![
          "passenger",
          "driver"
        ].includes(role)
      ) {
        return res.status(400).json({
          error:
            "ประเภทผู้ใช้ไม่ถูกต้อง"
        });
      }

      if (password.length < 6) {
        return res.status(400).json({
          error:
            "รหัสผ่านต้องมีอย่างน้อย 6 ตัว"
        });
      }

      const seats =
        role === "driver"
          ? Math.min(
              10,
              Math.max(
                1,
                Number(
                  vehicleSeats || 4
                )
              )
            )
          : 4;

      /*
       * สร้าง Auth User ฝั่ง server
       */

      const {
        data: created,
        error: createError
      } = await admin.auth.admin.createUser({
        email: cleanEmail,

        password,

        email_confirm: true,

        user_metadata: {
          name: cleanName,

          phone: cleanPhone,

          role
        }
      });

      if (createError) {
        return res.status(400).json({
          error:
            createError.message
        });
      }

      /*
       * สร้าง Profile
       */

      const {
        error: profileError
      } = await admin
        .from("profiles")
        .insert({
          id:
            created.user.id,

          name:
            cleanName,

          phone:
            cleanPhone,

          role,

          vehicle_seats:
            seats
        });

      if (profileError) {
        await admin.auth.admin.deleteUser(
          created.user.id
        );

        return res.status(400).json({
          error:
            profileError.message
        });
      }

      /*
       * Login ทันที
       */

      const {
        data: loginData,
        error: loginError
      } = await supabase.auth.signInWithPassword({
        email: cleanEmail,
        password
      });

      if (loginError) {
        return res.status(201).json({
          message:
            "สมัครสมาชิกสำเร็จ กรุณาเข้าสู่ระบบ",
          user: created.user
        });
      }

      const profile =
        await getProfile(
          created.user.id
        );

      return res.json({
        session:
          loginData.session,

        profile
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          error.message ||
          "สมัครสมาชิกไม่สำเร็จ"
      });
    }
  }
);

/* =========================================================
   LOGIN
========================================================= */

app.post(
  "/api/auth/login",
  async (req, res) => {
    try {
      const {
        email,
        password
      } = req.body;

      const {
        data,
        error
      } =
        await supabase.auth.signInWithPassword({
          email:
            cleanText(email).toLowerCase(),

          password
        });

      if (error) {
        return res.status(401).json({
          error:
            "อีเมลหรือรหัสผ่านไม่ถูกต้อง"
        });
      }

      const profile =
        await getProfile(
          data.user.id
        );

      res.json({
        session:
          data.session,

        profile
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          error.message ||
          "เข้าสู่ระบบไม่สำเร็จ"
      });
    }
  }
);

/* =========================================================
   CURRENT USER
========================================================= */

app.get(
  "/api/me",
  requireAuth,
  async (req, res) => {
    res.json({
      user: req.user,
      profile: req.profile
    });
  }
);

/* =========================================================
   REVERSE GEOCODE
========================================================= */

app.post(
  "/api/geocode/reverse",
  requireAuth,
  async (req, res) => {
    try {
      const {
        lat,
        lng
      } = req.body;

      if (
        !validCoordinate(
          lat,
          lng
        )
      ) {
        return res.status(400).json({
          error:
            "พิกัดไม่ถูกต้อง"
        });
      }

      const result =
        await reverseGeocode(
          Number(lat),
          Number(lng)
        );

      res.json(result);
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   CREATE RIDE
========================================================= */

app.post(
  "/api/rides",
  requireAuth,
  requireRole("passenger"),
  async (req, res) => {
    try {
      const {
        origin,
        destination,
        targetPassengers,
        originLat,
        originLng
      } = req.body;

      const originText =
        cleanText(origin);

      const destinationText =
        cleanText(destination);

      if (
        !originText ||
        !destinationText
      ) {
        return res.status(400).json({
          error:
            "กรุณากรอกต้นทางและปลายทาง"
        });
      }

      const target =
        Math.min(
          10,
          Math.max(
            1,
            Number(
              targetPassengers || 1
            )
          )
        );

      /*
       * ห้ามสร้างงานใหม่ถ้ามีงานเก่าอยู่
       */

      const {
        data: active
      } = await admin
        .from("ride_requests")
        .select(
          "id,status"
        )
        .eq(
          "passenger_id",
          req.user.id
        )
        .in("status", [
          "searching",
          "matched",
          "sent_to_driver",
          "accepted"
        ]);

      if (
        active &&
        active.length
      ) {
        return res.status(409).json({
          error:
            "คุณมีรายการเดินทางที่กำลังใช้งานอยู่แล้ว"
        });
      }

      /*
       * ต้นทาง
       */

      let originGeo = null;

      if (
        validCoordinate(
          originLat,
          originLng
        )
      ) {
        originGeo = {
          lat:
            Number(originLat),

          lng:
            Number(originLng)
        };
      } else {
        originGeo =
          await geocode(
            originText
          );
      }

      if (!originGeo) {
        return res.status(400).json({
          error:
            "ค้นหาต้นทางไม่พบ กรุณาใส่ชื่อสถานที่ให้ละเอียดขึ้น"
        });
      }

      /*
       * ปลายทาง
       */

      const destinationGeo =
        await geocode(
          destinationText
        );

      if (!destinationGeo) {
        return res.status(400).json({
          error:
            "ค้นหาปลายทางไม่พบ กรุณาใส่ชื่อสถานที่ให้ละเอียดขึ้น"
        });
      }

      /*
       * สร้าง Ride Request
       */

      const {
        data: ride,
        error: rideError
      } = await admin
        .from("ride_requests")
        .insert({
          passenger_id:
            req.user.id,

          origin_text:
            originText,

          destination_text:
            destinationText,

          origin_lat:
            originGeo.lat,

          origin_lng:
            originGeo.lng,

          destination_lat:
            destinationGeo.lat,

          destination_lng:
            destinationGeo.lng,

          target_passengers:
            target,

          status:
            "searching"
        })
        .select()
        .single();

      if (rideError) {
        throw new Error(
          rideError.message
        );
      }

      /*
       * Matching
       */

      const groupId =
        await findOrCreateGroup(
          ride
        );

      const group =
        await getGroupDetails(
          groupId
        );

      res.json({
        ride,
        group
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          error.message ||
          "สร้างรายการเดินทางไม่สำเร็จ"
      });
    }
  }
);

/* =========================================================
   ACTIVE RIDE
========================================================= */

app.get(
  "/api/rides/active",
  requireAuth,
  requireRole("passenger"),
  async (req, res) => {
    try {
      const {
        data: rides,
        error
      } = await admin
        .from("ride_requests")
        .select("*")
        .eq(
          "passenger_id",
          req.user.id
        )
        .in("status", [
          "searching",
          "matched",
          "sent_to_driver",
          "accepted"
        ])
        .order(
          "created_at",
          {
            ascending: false
          }
        )
        .limit(1);

      if (error) {
        throw new Error(
          error.message
        );
      }

      if (!rides || !rides.length) {
        return res.json({
          ride: null,
          group: null
        });
      }

      const ride =
        rides[0];

      if (!ride.group_id) {
        return res.json({
          ride,
          group: null
        });
      }

      const group =
        await getGroupDetails(
          ride.group_id
        );

      res.json({
        ride,
        group
      });
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   GET RIDE
========================================================= */

app.get(
  "/api/rides/:id",
  requireAuth,
  requireRole("passenger"),
  async (req, res) => {
    try {
      const {
        data: ride,
        error
      } = await admin
        .from("ride_requests")
        .select("*")
        .eq("id", req.params.id)
        .single();

      if (error || !ride) {
        return res.status(404).json({
          error:
            "ไม่พบรายการเดินทาง"
        });
      }

      if (
        ride.passenger_id !==
        req.user.id
      ) {
        return res.status(403).json({
          error:
            "ไม่มีสิทธิ์ดูรายการนี้"
        });
      }

      const group =
        ride.group_id
          ? await getGroupDetails(
              ride.group_id
            )
          : null;

      res.json({
        ride,
        group
      });
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   CONFIRM GROUP
========================================================= */

app.post(
  "/api/groups/:id/confirm",
  requireAuth,
  requireRole("passenger"),
  async (req, res) => {
    try {
      const group =
        await getRawGroup(
          req.params.id
        );

      if (
        [
          "completed",
          "cancelled"
        ].includes(group.status)
      ) {
        return res.status(400).json({
          error:
            "กลุ่มนี้ปิดงานแล้ว"
        });
      }

      const {
        data: member,
        error: memberError
      } = await admin
        .from("ride_group_members")
        .select("*")
        .eq(
          "group_id",
          group.id
        )
        .eq(
          "passenger_id",
          req.user.id
        )
        .single();

      if (
        memberError ||
        !member
      ) {
        return res.status(403).json({
          error:
            "คุณไม่ได้อยู่ในกลุ่มนี้"
        });
      }

      await admin
        .from("ride_group_members")
        .update({
          confirmed: true
        })
        .eq(
          "id",
          member.id
        );

      const {
        data: members
      } = await admin
        .from("ride_group_members")
        .select("*")
        .eq(
          "group_id",
          group.id
        );

      const allConfirmed =
        members.length > 0 &&
        members.every(
          (m) =>
            m.confirmed === true
        );

      if (allConfirmed) {
        await admin
          .from("ride_groups")
          .update({
            status:
              "sent_to_driver",

            confirmed_at:
              new Date().toISOString()
          })
          .eq(
            "id",
            group.id
          );

        await admin
          .from("ride_requests")
          .update({
            status:
              "sent_to_driver"
          })
          .eq(
            "group_id",
            group.id
          );

        /*
         * คำนวณเส้นทาง
         */

        try {
          await rebuildGroupRoute(
            group.id
          );
        } catch (routeError) {
          console.error(
            "Route error:",
            routeError.message
          );
        }
      }

      const result =
        await getGroupDetails(
          group.id
        );

      res.json({
        group: result
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   DRIVER JOBS
========================================================= */

app.get(
  "/api/driver/jobs",
  requireAuth,
  requireRole("driver"),
  async (req, res) => {
    try {
      const {
        data: waiting,
        error: waitingError
      } = await admin
        .from("ride_groups")
        .select("*")
        .eq(
          "status",
          "sent_to_driver"
        )
        .order(
          "created_at",
          {
            ascending: true
          }
        );

      if (waitingError) {
        throw new Error(
          waitingError.message
        );
      }

      const {
        data: accepted,
        error: acceptedError
      } = await admin
        .from("ride_groups")
        .select("*")
        .eq(
          "status",
          "accepted"
        )
        .eq(
          "driver_id",
          req.user.id
        )
        .order(
          "created_at",
          {
            ascending: true
          }
        );

      if (acceptedError) {
        throw new Error(
          acceptedError.message
        );
      }

      const groups = [
        ...(waiting || []),
        ...(accepted || [])
      ];

      const details =
        await Promise.all(
          groups.map(
            (group) =>
              getGroupDetails(
                group.id
              )
          )
        );

      res.json({
        jobs: details,

        driver:
          req.profile
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   DRIVER ACCEPT JOB
========================================================= */

app.post(
  "/api/driver/jobs/:id/accept",
  requireAuth,
  requireRole("driver"),
  async (req, res) => {
    try {
      const group =
        await getGroupDetails(
          req.params.id
        );

      if (
        group.status !==
        "sent_to_driver"
      ) {
        return res.status(400).json({
          error:
            "งานนี้ถูกรับไปแล้วหรือไม่พร้อมรับ"
        });
      }

      if (
        group.actual_passengers >
        req.profile.vehicle_seats
      ) {
        return res.status(400).json({
          error:
            `ผู้โดยสาร ${group.actual_passengers} คน แต่รถรองรับ ${req.profile.vehicle_seats} คน`
        });
      }

      /*
       * รับงานแบบตรวจ status ด้วย
       * ป้องกันคนขับสองคนรับพร้อมกัน
       */

      const {
        data: updated,
        error
      } = await admin
        .from("ride_groups")
        .update({
          status:
            "accepted",

          driver_id:
            req.user.id,

          accepted_at:
            new Date().toISOString()
        })
        .eq(
          "id",
          req.params.id
        )
        .eq(
          "status",
          "sent_to_driver"
        )
        .select()
        .maybeSingle();

      if (error) {
        throw new Error(
          error.message
        );
      }

      if (!updated) {
        return res.status(409).json({
          error:
            "มีคนขับคนอื่นรับงานนี้ไปแล้ว"
        });
      }

      await admin
        .from("ride_requests")
        .update({
          status:
            "accepted"
        })
        .eq(
          "group_id",
          req.params.id
        );

      const result =
        await getGroupDetails(
          req.params.id
        );

      res.json({
        group:
          result
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   DRIVER GPS
========================================================= */

app.post(
  "/api/driver/location",
  requireAuth,
  requireRole("driver"),
  async (req, res) => {
    try {
      const {
        latitude,
        longitude,
        heading,
        speed,
        accuracy
      } = req.body;

      if (
        !validCoordinate(
          latitude,
          longitude
        )
      ) {
        return res.status(400).json({
          error:
            "GPS ไม่ถูกต้อง"
        });
      }

      const {
        data,
        error
      } = await admin
        .from("driver_locations")
        .upsert(
          {
            driver_id:
              req.user.id,

            latitude:
              Number(latitude),

            longitude:
              Number(longitude),

            heading:
              Number.isFinite(
                Number(heading)
              )
                ? Number(heading)
                : null,

            speed:
              Number.isFinite(
                Number(speed)
              )
                ? Number(speed)
                : null,

            accuracy:
              Number.isFinite(
                Number(accuracy)
              )
                ? Number(accuracy)
                : null,

            updated_at:
              new Date().toISOString()
          },
          {
            onConflict:
              "driver_id"
          }
        )
        .select()
        .single();

      if (error) {
        throw new Error(
          error.message
        );
      }

      res.json({
        location:
          data
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   COMPLETE JOB
========================================================= */

app.post(
  "/api/driver/jobs/:id/complete",
  requireAuth,
  requireRole("driver"),
  async (req, res) => {
    try {
      const {
        data: group,
        error
      } = await admin
        .from("ride_groups")
        .update({
          status:
            "completed",

          completed_at:
            new Date().toISOString()
        })
        .eq(
          "id",
          req.params.id
        )
        .eq(
          "driver_id",
          req.user.id
        )
        .eq(
          "status",
          "accepted"
        )
        .select()
        .maybeSingle();

      if (error) {
        throw new Error(
          error.message
        );
      }

      if (!group) {
        return res.status(400).json({
          error:
            "ไม่สามารถจบทริปนี้ได้"
        });
      }

      await admin
        .from("ride_requests")
        .update({
          status:
            "completed"
        })
        .eq(
          "group_id",
          req.params.id
        );

      res.json({
        message:
          "จบทริปเรียบร้อย"
      });
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   HISTORY
========================================================= */

app.get(
  "/api/history",
  requireAuth,
  async (req, res) => {
    try {
      if (
        req.profile.role ===
        "passenger"
      ) {
        const {
          data,
          error
        } = await admin
          .from("ride_requests")
          .select("*")
          .eq(
            "passenger_id",
            req.user.id
          )
          .order(
            "created_at",
            {
              ascending: false
            }
          );

        if (error) {
          throw new Error(
            error.message
          );
        }

        return res.json({
          role:
            "passenger",

          rides:
            data || []
        });
      }

      const {
        data,
        error
      } = await admin
        .from("ride_groups")
        .select("*")
        .eq(
          "driver_id",
          req.user.id
        )
        .order(
          "created_at",
          {
            ascending: false
          }
        );

      if (error) {
        throw new Error(
          error.message
        );
      }

      const groups =
        await Promise.all(
          (data || []).map(
            (g) =>
              getGroupDetails(
                g.id
              )
          )
        );

      res.json({
        role:
          "driver",

        rides:
          groups
      });
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   PAGES
========================================================= */

app.get("/", (req, res) => {
  res.sendFile(
    path.join(
      PUBLIC_DIR,
      "index.html"
    )
  );
});

app.get(
  "/passenger",
  (req, res) => {
    res.sendFile(
      path.join(
        PUBLIC_DIR,
        "passenger.html"
      )
    );
  }
);

app.get(
  "/driver",
  (req, res) => {
    res.sendFile(
      path.join(
        PUBLIC_DIR,
        "driver.html"
      )
    );
  }
);

app.get(
  "/history",
  (req, res) => {
    res.sendFile(
      path.join(
        PUBLIC_DIR,
        "history.html"
      )
    );
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (error, req, res, next) => {
    console.error(error);

    res.status(500).json({
      error:
        "Server error"
    });
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `UP Drive running at http://localhost:${PORT}`
    );
  }
);