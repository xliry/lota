export class LotaApiClient {
  private baseUrl: string;
  private serviceKey: string;
  private agentId: string | undefined;

  constructor() {
    this.baseUrl = process.env.LOTA_API_URL || "http://localhost:3000";
    this.serviceKey = process.env.LOTA_SERVICE_KEY || "";
    this.agentId = process.env.LOTA_AGENT_ID;
  }

  setAgentId(agentId: string) {
    this.agentId = agentId;
  }

  getAgentId(): string | undefined {
    return this.agentId;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.serviceKey) {
      headers["x-service-key"] = this.serviceKey;
    }
    if (this.agentId) {
      headers["x-agent-id"] = this.agentId;
    }
    return headers;
  }

  async get<T = unknown>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET ${path} failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: this.getHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`POST ${path} failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const res = await fetch(url.toString(), {
      method: "PATCH",
      headers: this.getHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`PATCH ${path} failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async put<T = unknown>(path: string, body?: unknown): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const res = await fetch(url.toString(), {
      method: "PUT",
      headers: this.getHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`PUT ${path} failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async delete<T = unknown>(path: string): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const res = await fetch(url.toString(), {
      method: "DELETE",
      headers: this.getHeaders(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DELETE ${path} failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<T>;
  }
}

export const api = new LotaApiClient();
