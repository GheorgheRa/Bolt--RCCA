/**
 * @typedef {Object} RequestOptions
 * @property {string} [method]
 * @property {unknown} [body]
 * @property {HeadersInit} [headers]
 * @property {RequestCredentials} [credentials]
 */

/**
 * @param {string} url
 * @param {RequestOptions} [requestOptions]
 */
const request = async (url, { method = 'GET', body, ...options } = {}) => {
  const response = await fetch(url, {
    ...options,
    method,
    credentials: 'same-origin',
    headers: {
      'X-App-Request': 'true',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = Object.assign(new Error(data?.error || `Request failed with status ${response.status}.`), {
      status: response.status,
      data,
    });
    throw error;
  }
  return data;
};

/**
 * @typedef {Object} EntityMethods
 * @property {(sort?: string|null, limit?: number) => Promise<any[]>} list
 * @property {(filter: Record<string, any>, sort?: string|null, limit?: number) => Promise<any[]>} filter
 * @property {(id: string) => Promise<any>} get
 * @property {(data: Record<string, any>) => Promise<any>} create
 * @property {(id: string, data: Record<string, any>) => Promise<any>} update
 * @property {(id: string) => Promise<any>} delete
 * @property {(data: Record<string, any>[]) => Promise<any[]>} bulkCreate
 * @property {(data: Record<string, any>[]) => Promise<any[]>} bulkUpdate
 * @property {(callback: (event: any) => void) => () => void} subscribe
 */

/** @type {Record<string, EntityMethods>} */
const entityClient = new Proxy({}, {
  get: (_, entity) => {
    if (typeof entity !== 'string') return undefined;
    return ({
    list: (sort, limit) => {
      const params = new URLSearchParams();
      if (sort) params.set('sort', sort);
      if (limit != null) params.set('limit', String(limit));
      const query = params.size ? `?${params}` : '';
      return request(`/api/entities/${entity}${query}`);
    },
    filter: (filter, sort, limit) => {
      const params = new URLSearchParams({ filter: JSON.stringify(filter || {}) });
      if (sort) params.set('sort', sort);
      if (limit != null) params.set('limit', String(limit));
      return request(`/api/entities/${entity}?${params}`);
    },
    get: id => request(`/api/entities/${entity}/${encodeURIComponent(id)}`),
    create: data => request(`/api/entities/${entity}`, { method: 'POST', body: data }),
    update: (id, data) => request(`/api/entities/${entity}/${encodeURIComponent(id)}`, { method: 'PATCH', body: data }),
    delete: id => request(`/api/entities/${entity}/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    bulkCreate: data => request(`/api/entities/${entity}/bulk`, { method: 'POST', body: data }),
    bulkUpdate: data => request(`/api/entities/${entity}/bulk-update`, { method: 'POST', body: data }),
    subscribe: callback => {
      let stopped = false;
      let polling = false;
      let initialized = false;
      let snapshot = new Map();
      const poll = async () => {
        if (stopped || polling) return;
        polling = true;
        try {
          const records = await request(`/api/entities/${entity}?limit=50000`);
          if (stopped) return;
          const next = new Map(records.map(record => [record.id, record]));
          if (!initialized) {
            snapshot = next;
            initialized = true;
            return;
          }
          for (const [id, record] of next) {
            if (!snapshot.has(id)) callback({ type: 'create', id, data: record });
            else if (JSON.stringify(snapshot.get(id)) !== JSON.stringify(record)) callback({ type: 'update', id, data: record });
          }
          for (const id of snapshot.keys()) {
            if (!next.has(id)) callback({ type: 'delete', id });
          }
          snapshot = next;
        } catch (error) {
          if (error.status !== 401) console.error(`Could not refresh ${entity} updates:`, error);
        } finally {
          polling = false;
        }
      };
      poll();
      const timer = window.setInterval(poll, 15000);
      return () => {
        stopped = true;
        window.clearInterval(timer);
      };
    },
    });
  },
});

const auth = {
  me: () => request('/api/auth/me'),
  login: credentials => request('/api/auth/login', { method: 'POST', body: credentials }),
  bootstrap: credentials => request('/api/auth/bootstrap', { method: 'POST', body: credentials }),
  createUser: account => request('/api/auth/users', { method: 'POST', body: account }),
  changePassword: credentials => request('/api/auth/change-password', { method: 'POST', body: credentials }),
  logout: async () => {
    await request('/api/auth/logout', { method: 'POST' }).catch(error => {
      if (error.status !== 401) throw error;
    });
    window.dispatchEvent(new Event('rcca:logout'));
  },
  isAuthenticated: async () => {
    try {
      await request('/api/auth/me');
      return true;
    } catch (error) {
      if (error.status === 401) return false;
      throw error;
    }
  },
};

const functions = {
  invoke: async (name, data) => ({ data: await request(`/api/functions/${encodeURIComponent(name)}`, { method: 'POST', body: data }) }),
};

const integrations = {
  Core: {
    InvokeLLM: input => functions.invoke('invokeLLM', input).then(result => result.data),
    SendEmail: input => functions.invoke('sendEmail', input).then(result => result.data),
    UploadFile: async ({ file }) => {
      if (!(file instanceof File)) throw new TypeError('UploadFile expects a File.');
      const fileData = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Could not read the selected file.'));
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
      });
      return request('/api/integrations/upload', {
        method: 'POST',
        body: { file_name: file.name, file_type: file.type, file_data: fileData },
      });
    },
  },
};

export const appApi = { entities: entityClient, auth, functions, integrations };
