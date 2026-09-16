const SPOTIFY_ACCOUNTS_URL = "https://accounts.spotify.com";
const SPOTIFY_API_URL = "https://api.spotify.com/v1";

const REQUIRED_SCOPE = "user-read-currently-playing";

function json(data, status = 200, origin = "*") {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
        }
    });
}

function redirect(url) {
    return new Response(null, {
        status: 302,
        headers: {
            Location: url
        }
    });
}

function randomString(length = 32) {
    const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    const array = new Uint8Array(length);

    crypto.getRandomValues(array);

    return Array.from(array)
        .map((value) => chars[value % chars.length])
        .join("");
}

async function getAccessToken(env) {
    const refreshToken =
        await env.SPOTIFY_AUTH.get("refresh_token");

    if (!refreshToken) {
        throw new Error("Spotify nie jest jeszcze połączone.");
    }

    const credentials = btoa(
        `${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`
    );

    const response = await fetch(
        `${SPOTIFY_ACCOUNTS_URL}/api/token`,
        {
            method: "POST",

            headers: {
                "Authorization": `Basic ${credentials}`,
                "Content-Type":
                    "application/x-www-form-urlencoded"
            },

            body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken
            })
        }
    );

    if (!response.ok) {
        const text = await response.text();

        throw new Error(
            `Nie udało się odświeżyć tokena Spotify: ${text}`
        );
    }

    const data = await response.json();

    if (data.refresh_token) {
        await env.SPOTIFY_AUTH.put(
            "refresh_token",
            data.refresh_token
        );
    }

    return data.access_token;
}


async function handleLogin(request, env) {
    const state = randomString(48);

    await env.SPOTIFY_AUTH.put(
        `state:${state}`,
        "valid",
        {
            expirationTtl: 600
        }
    );

    const url = new URL(
        `${SPOTIFY_ACCOUNTS_URL}/authorize`
    );

    url.searchParams.set(
        "client_id",
        env.SPOTIFY_CLIENT_ID
    );

    url.searchParams.set(
        "response_type",
        "code"
    );

    url.searchParams.set(
        "redirect_uri",
        env.SPOTIFY_REDIRECT_URI
    );

    url.searchParams.set(
        "scope",
        REQUIRED_SCOPE
    );

    url.searchParams.set(
        "state",
        state
    );

    return redirect(url.toString());
}


async function handleCallback(request, env) {
    const url = new URL(request.url);

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
        return new Response(
            `Spotify OAuth error: ${error}`,
            {
                status: 400,
                headers: {
                    "Content-Type": "text/plain; charset=utf-8"
                }
            }
        );
    }

    if (!code || !state) {
        return new Response(
            "Brakuje code lub state.",
            {
                status: 400
            }
        );
    }

    const validState =
        await env.SPOTIFY_AUTH.get(
            `state:${state}`
        );

    if (!validState) {
        return new Response(
            "Nieprawidłowy lub wygasły state.",
            {
                status: 403
            }
        );
    }

    await env.SPOTIFY_AUTH.delete(
        `state:${state}`
    );

    const credentials = btoa(
        `${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`
    );

    const tokenResponse = await fetch(
        `${SPOTIFY_ACCOUNTS_URL}/api/token`,
        {
            method: "POST",

            headers: {
                "Authorization": `Basic ${credentials}`,
                "Content-Type":
                    "application/x-www-form-urlencoded"
            },

            body: new URLSearchParams({
                grant_type: "authorization_code",
                code,
                redirect_uri:
                    env.SPOTIFY_REDIRECT_URI
            })
        }
    );

    if (!tokenResponse.ok) {
        const text = await tokenResponse.text();

        return new Response(
            `Spotify token error: ${text}`,
            {
                status: 500,
                headers: {
                    "Content-Type":
                        "text/plain; charset=utf-8"
                }
            }
        );
    }

    const tokenData =
        await tokenResponse.json();

    if (!tokenData.refresh_token) {
        return new Response(
            "Spotify nie zwrócił refresh tokena.",
            {
                status: 500
            }
        );
    }

    await env.SPOTIFY_AUTH.put(
        "refresh_token",
        tokenData.refresh_token
    );

    return redirect(
        `${env.FRONTEND_URL}?spotify=connected`
    );
}


async function handleCurrentlyPlaying(request, env) {
    const origin =
        request.headers.get("Origin") || "*";

    let accessToken;

    try {
        accessToken =
            await getAccessToken(env);
    } catch (error) {
        return json(
            {
                connected: false,
                playing: false,
                error: error.message
            },
            401,
            origin
        );
    }

    const response = await fetch(
        `${SPOTIFY_API_URL}/me/player/currently-playing`,
        {
            headers: {
                Authorization:
                    `Bearer ${accessToken}`
            }
        }
    );

    if (response.status === 204) {
        return json(
            {
                connected: true,
                playing: false
            },
            200,
            origin
        );
    }

    if (response.status === 401) {
        return json(
            {
                connected: false,
                playing: false
            },
            401,
            origin
        );
    }

    if (!response.ok) {
        const text = await response.text();

        return json(
            {
                connected: true,
                playing: false,
                error: text
            },
            response.status,
            origin
        );
    }

    const data = await response.json();

    if (!data || !data.item) {
        return json(
            {
                connected: true,
                playing: false
            },
            200,
            origin
        );
    }

    if (data.item.type !== "track") {
        return json(
            {
                connected: true,
                playing: false
            },
            200,
            origin
        );
    }

    const track = data.item;

    const artists =
        track.artists
            ?.map((artist) => artist.name)
            .join(", ") || "";

    const albumImage =
        track.album?.images?.[0]?.url || "";

    return json(
        {
            connected: true,
            playing: Boolean(data.is_playing),

            track: {
                id: track.id,
                name: track.name,
                artists,
                album: track.album?.name || "",
                image: albumImage,
                spotifyUrl:
                    track.external_urls?.spotify || ""
            },

            progressMs:
                data.progress_ms || 0,

            durationMs:
                track.duration_ms || 0
        },
        200,
        origin
    );
}


async function handleRequest(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods":
                    "GET, OPTIONS",
                "Access-Control-Allow-Headers":
                    "Content-Type"
            }
        });
    }

    if (url.pathname === "/login") {
        return handleLogin(request, env);
    }

    if (url.pathname === "/callback") {
        return handleCallback(request, env);
    }

    if (
        url.pathname ===
        "/api/currently-playing"
    ) {
        return handleCurrentlyPlaying(
            request,
            env
        );
    }

    if (url.pathname === "/") {
        return new Response(
            "Kitsun3 Kage Spotify API",
            {
                headers: {
                    "Content-Type":
                        "text/plain; charset=utf-8"
                }
            }
        );
    }

    return new Response(
        "Not Found",
        {
            status: 404
        }
    );
}


export default {
    async fetch(request, env) {
        try {
            return await handleRequest(
                request,
                env
            );
        } catch (error) {
            return new Response(
                `Internal error: ${error.message}`,
                {
                    status: 500,
                    headers: {
                        "Content-Type":
                            "text/plain; charset=utf-8"
                    }
                }
            );
        }
    }
};