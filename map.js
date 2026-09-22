const UP_CENTER = [19.02843, 99.89624];

let upMap = null;

let routeLayer = null;

let markerLayer = null;

const driverMarkers = new Map();

function initMap(
  elementId = "map"
) {
  if (upMap) {
    return upMap;
  }

  upMap = L.map(
    elementId,
    {
      zoomControl: true
    }
  ).setView(
    UP_CENTER,
    14
  );

  L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      attribution:
        '&copy; OpenStreetMap contributors'
    }
  ).addTo(upMap);

  markerLayer =
    L.layerGroup().addTo(
      upMap
    );

  return upMap;
}

function clearMapMarkers() {
  if (!markerLayer) return;

  markerLayer.clearLayers();

  driverMarkers.clear();
}

function addPoint(
  lat,
  lng,
  title,
  type = "pickup"
) {
  if (!upMap) return null;

  let iconHtml = "📍";

  if (type === "destination") {
    iconHtml = "🏁";
  }

  if (type === "driver") {
    iconHtml = "🚗";
  }

  const icon =
    L.divIcon({
      className:
        "custom-map-icon",

      html:
        `<div>${iconHtml}</div>`,

      iconSize: [38, 38],

      iconAnchor: [19, 19]
    });

  const marker =
    L.marker(
      [lat, lng],
      {
        icon
      }
    )
      .addTo(markerLayer)
      .bindPopup(
        `<strong>${escapeHtml(
          title || ""
        )}</strong>`
      );

  return marker;
}

function drawRoute(
  geometry
) {
  if (!upMap || !geometry) {
    return;
  }

  if (routeLayer) {
    upMap.removeLayer(
      routeLayer
    );
  }

  routeLayer =
    L.geoJSON(
      geometry,
      {
        style: {
          weight: 6,
          opacity: 0.85
        }
      }
    ).addTo(upMap);

  upMap.fitBounds(
    routeLayer.getBounds(),
    {
      padding: [30, 30]
    }
  );
}

function showRideOnMap(
  ride
) {
  if (!upMap || !ride) {
    return;
  }

  clearMapMarkers();

  addPoint(
    ride.origin_lat,
    ride.origin_lng,
    `ต้นทาง: ${ride.origin_text}`,
    "pickup"
  );

  addPoint(
    ride.destination_lat,
    ride.destination_lng,
    `ปลายทาง: ${ride.destination_text}`,
    "destination"
  );

  upMap.fitBounds(
    L.latLngBounds([
      [
        ride.origin_lat,
        ride.origin_lng
      ],
      [
        ride.destination_lat,
        ride.destination_lng
      ]
    ]),
    {
      padding: [40, 40]
    }
  );
}

function showGroupOnMap(
  group
) {
  if (!upMap || !group) {
    return;
  }

  clearMapMarkers();

  const bounds = [];

  for (
    const member of
    group.members || []
  ) {
    if (!member.ride) {
      continue;
    }

    addPoint(
      member.ride.origin_lat,
      member.ride.origin_lng,
      `${member.passenger?.name || "ผู้โดยสาร"} - จุดรับ`,
      "pickup"
    );

    addPoint(
      member.ride.destination_lat,
      member.ride.destination_lng,
      `${member.passenger?.name || "ผู้โดยสาร"} - จุดส่ง`,
      "destination"
    );

    bounds.push([
      member.ride.origin_lat,
      member.ride.origin_lng
    ]);

    bounds.push([
      member.ride.destination_lat,
      member.ride.destination_lng
    ]);
  }

  if (
    group.route &&
    group.route.geometry
  ) {
    drawRoute(
      group.route.geometry
    );
  }

  if (
    bounds.length &&
    !routeLayer
  ) {
    upMap.fitBounds(
      L.latLngBounds(bounds),
      {
        padding: [40, 40]
      }
    );
  }
}

function updateDriverMarker(
  driverId,
  latitude,
  longitude,
  name = "คนขับ"
) {
  if (!upMap) return;

  if (
    driverMarkers.has(
      driverId
    )
  ) {
    const marker =
      driverMarkers.get(
        driverId
      );

    marker.setLatLng([
      latitude,
      longitude
    ]);

    return;
  }

  const marker =
    addPoint(
      latitude,
      longitude,
      name,
      "driver"
    );

  driverMarkers.set(
    driverId,
    marker
  );
}

function escapeHtml(
  value
) {
  return String(value || "")
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}

function formatDistance(
  meters
) {
  if (!Number.isFinite(
    Number(meters)
  )) {
    return "-";
  }

  const km =
    Number(meters) / 1000;

  return `${km.toFixed(1)} กม.`;
}

function formatDuration(
  seconds
) {
  if (!Number.isFinite(
    Number(seconds)
  )) {
    return "-";
  }

  const minutes =
    Math.round(
      Number(seconds) / 60
    );

  if (minutes < 60) {
    return `${minutes} นาที`;
  }

  const hours =
    Math.floor(
      minutes / 60
    );

  const remaining =
    minutes % 60;

  return `${hours} ชม. ${remaining} นาที`;
}