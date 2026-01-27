import { getGithub } from '../../../lib/auth';
import { createSession, generateSessionToken } from '../../../lib/session';
import { getDb } from '../../../lib/db';
import { users } from '../../../../db/schema';
import { eq } from 'drizzle-orm';
import type { APIRoute } from 'astro';
import type { OAuth2Tokens } from 'arctic';

export const GET: APIRoute = async ({ request, cookies, locals, redirect }) => {
	const url = new URL(request.url);
	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const storedState = cookies.get('github_oauth_state')?.value ?? null;

	if (!code || !state || !storedState || state !== storedState) {
		return new Response(null, {
			status: 400
		});
	}

	try {
        console.log("Validating GitHub code...");
		const tokens: OAuth2Tokens = await getGithub(locals.runtime.env).validateAuthorizationCode(code);
        const accessToken = tokens.accessToken();
        console.log("Tokens received:", accessToken ? "Present" : "Missing");

        let githubUser: GitHubUser;
        try {
            console.log("Fetching GitHub user...");
            const githubUserResponse = await fetch('https://api.github.com/user', {
                headers: {
                    Authorization: `Bearer ${accessToken.trim()}`
                }
            });
            
            if (!githubUserResponse.ok) {
                const errorText = await githubUserResponse.text();
                console.error("GitHub API error:", githubUserResponse.status, errorText);
                throw new Error(`GitHub API returned ${githubUserResponse.status}: ${errorText.slice(0, 200)}`);
            }
            
            githubUser = await githubUserResponse.json();
            console.log("GitHub User fetched:", githubUser.login);
        } catch (fetchError: any) {
             throw new Error(`Failed to fetch GitHub user: ${fetchError.message}`);
        }

		const db = getDb(locals.runtime.env);

		const existingUser = await db.select().from(users).where(eq(users.githubId, githubUser.id)).get();

		let userId = "";

		if (existingUser) {
			userId = existingUser.id;
		} else {
            // Create user
            userId = crypto.randomUUID();
            await db.insert(users).values({
                id: userId,
                githubId: githubUser.id,
                username: githubUser.login
            });
		}

	
		console.log("Creating session, userId:", userId);
		const token = generateSessionToken();
		const session = await createSession(token, userId, db, locals.runtime.env);
        
        console.log("Setting session cookie...");
		cookies.set('session', token, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: import.meta.env.PROD,
			expires: new Date(session.expiresAt)
		});
		
		// Retrieve redirect URL from cookie or default to home
        const redirectUrl = cookies.get('login_redirect')?.value ?? '/';
        // Clean up the cookie
        cookies.delete('login_redirect', { path: '/' });

        const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Login Successful</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <meta http-equiv="refresh" content="2;url=${redirectUrl}">
        </head>
        <body class="bg-[#0a0a0a] text-white flex items-center justify-center min-h-screen">
            <div class="text-center space-y-4 p-8 bg-white/5 rounded-2xl border border-white/10 backdrop-blur-xl max-w-sm w-full mx-4 shadow-2xl">
                <div class="relative w-16 h-16 mx-auto mb-4">
                    <div class="absolute inset-0 bg-green-500/20 rounded-full animate-ping"></div>
                    <div class="relative bg-green-500/10 rounded-full w-16 h-16 flex items-center justify-center border border-green-500/20">
                        <svg class="w-8 h-8 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                        </svg>
                    </div>
                </div>
                <h2 class="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-gray-400">Welcome Back!</h2>
                <p class="text-gray-400 text-sm">Successfully logged in with GitHub.</p>
                <p class="text-gray-500 text-xs mt-2">Redirecting you in a moment...</p>
                <div class="w-full bg-white/5 rounded-full h-1 mt-6 overflow-hidden">
                    <div class="bg-green-500 h-full w-full origin-left animate-[progress_2s_ease-in-out_infinite]"></div>
                </div>
            </div>
            <script>
                setTimeout(() => {
                    window.location.href = "${redirectUrl}";
                }, 1500);
            </script>
            <style>
                @keyframes progress {
                    0% { transform: scaleX(0); }
                    100% { transform: scaleX(1); }
                }
            </style>
        </body>
        </html>
        `;

		return new Response(html, {
            headers: {
                'Content-Type': 'text/html'
            }
        });
	} catch (e: any) {
        console.error(e);
		return new Response(JSON.stringify({
            error: e.message,
            stack: e.stack
        }, null, 2), {
			status: 500
		});
	}
};

interface GitHubUser {
	id: number;
	login: string;
}
