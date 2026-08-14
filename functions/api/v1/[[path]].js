export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const suffix = url.pathname.replace(/^\/api\/v1/, "") || "/";
  const target = `https://xyihewuuyxailwunwgus.supabase.co/functions/v1/agent-api${suffix}${url.search}`;
  const headers = new Headers(request.headers);
  headers.set("apikey", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmVzZSIsInJlZiI6Inh5aWhld3V1eXhhaWx3dW53Z3VzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2NDk3NTUsImV4cCI6MjEwMjIyNTc1NX0.ymH0G38KZHRmvKCs0vrSG37TKSxtxWjPYMQfkq1Pt4A");
  return fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
  });
}
