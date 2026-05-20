/**
 * ═══════════════════════════════════════════════════════════════════
 *  Google Apps Script — Control Vehicular · Papeles Nacionales S.A.S.
 *  Versión con OAuth Google (GSI) para Admin y Visor
 * ═══════════════════════════════════════════════════════════════════
 *
 *  CONFIGURACIÓN REQUERIDA (Script Properties):
 *  ─────────────────────────────────────────────
 *  Ve a: Apps Script → ⚙️ Configuración del proyecto → Propiedades del script
 *
 *  Clave                  │ Valor de ejemplo
 *  ───────────────────────┼──────────────────────────────────────────
 *  GOOGLE_CLIENT_ID       │ 123456789-abc.apps.googleusercontent.com
 *  SESSION_SECRET         │ (cadena aleatoria larga, ≥ 32 caracteres)
 *  ADMIN_EMAILS           │ admin@tuempresa.com,otro@tuempresa.com
 *  VIEWER_EMAILS          │ visor1@tuempresa.com,visor2@tuempresa.com
 *  SESSION_TTL_HOURS      │ 8
 *  SPREADSHEET_ID         │ ID de tu hoja de Google Sheets
 *
 *  OBTENER CLIENT ID:
 *  ──────────────────
 *  1. console.cloud.google.com → Selecciona o crea un proyecto
 *  2. APIs & Services → Credenciales → Crear credencial → ID de cliente OAuth 2.0
 *  3. Tipo: Aplicación web
 *  4. Orígenes autorizados: https://TU_DOMINIO.com (donde está alojada la PWA)
 *  5. Copia el "ID de cliente" (termina en .apps.googleusercontent.com)
 *
 *  DESPLIEGUE:
 *  ───────────
 *  1. Pega este código en el editor de Apps Script
 *  2. Configura las Script Properties (arriba)
 *  3. Implementar → Nueva implementación → Aplicación web
 *     - Ejecutar como: Yo (tu cuenta)
 *     - Quién tiene acceso: Cualquier persona
 *  4. Copia la URL /exec y pégala en la pantalla de configuración de la PWA
 */

// ──────────────────────────────────────────────────────────────────
//  CONSTANTES DE CONFIGURACIÓN
// ──────────────────────────────────────────────────────────────────
function getConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    clientId:    props.getProperty('GOOGLE_CLIENT_ID')   || '',
    secret:      props.getProperty('SESSION_SECRET')     || 'cambiar-esto-urgente',
    adminEmails: (props.getProperty('ADMIN_EMAILS')      || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean),
    viewerEmails:(props.getProperty('VIEWER_EMAILS')     || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean),
    ttlHours:    parseInt(props.getProperty('SESSION_TTL_HOURS') || '8', 10),
    sheetId:     props.getProperty('SPREADSHEET_ID')     || '',
  };
}

// ──────────────────────────────────────────────────────────────────
//  PUNTO DE ENTRADA HTTP
// ──────────────────────────────────────────────────────────────────
function doGet(e) {
  const params = e.parameter || {};
  const accion = params.accion || '';
  const sessionToken = params.session_token || '';

  try {
    if (accion === 'registros') {
      const auth = verificarSesion(sessionToken);
      if (!auth.ok) return jsonErr(auth.error, 401);
      return jsonOk(obtenerRegistros(params.porteria || null));
    }

    if (accion === 'recurrentes') {
      const auth = verificarSesion(sessionToken);
      if (!auth.ok) return jsonErr(auth.error, 401);
      return jsonOk(obtenerRecurrentes());
    }

    return jsonErr('Acción no reconocida', 400);
  } catch (err) {
    console.error('doGet error:', err.message);
    return jsonErr('Error interno', 500);
  }
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch {
    return jsonErr('JSON inválido', 400);
  }

  const accion = body.accion || body.tipo_operacion || '';

  try {
    // ── Autenticación OAuth (no requiere sesión previa) ──
    if (accion === 'oauth_login') {
      return manejarOAuthLogin(body);
    }

    // ── Operaciones protegidas (requieren session_token) ──
    const auth = verificarSesion(body.session_token || '');
    if (!auth.ok) return jsonErr(auth.error, 401);

    if (accion === 'registro' || accion === 'tipo_operacion:registro') {
      return jsonOk(guardarRegistro(body, auth));
    }
    if (accion === 'recurrente_agregar') {
      verificarRol(auth, ['admin']);
      return jsonOk(agregarRecurrente(body));
    }
    if (accion === 'recurrente_eliminar') {
      verificarRol(auth, ['admin']);
      return jsonOk(eliminarRecurrente(body.id));
    }

    return jsonErr('Acción no reconocida', 400);
  } catch (err) {
    console.error('doPost error:', err.message);
    if (err.message === 'FORBIDDEN') return jsonErr('Sin permisos para esta acción', 403);
    return jsonErr('Error interno: ' + err.message, 500);
  }
}

// ──────────────────────────────────────────────────────────────────
//  OAUTH — VALIDACIÓN DEL CREDENTIAL JWT DE GOOGLE
// ──────────────────────────────────────────────────────────────────
function manejarOAuthLogin(body) {
  const cfg = getConfig();
  const credential = body.credential || '';
  if (!credential) return jsonErr('credential requerido', 400);

  // Validar el JWT de Google usando el endpoint de tokeninfo
  let payload;
  try {
    const verifyUrl = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential);
    const resp = UrlFetchApp.fetch(verifyUrl, { muteHttpExceptions: true });
    const status = resp.getResponseCode();
    if (status !== 200) {
      console.warn('tokeninfo returned', status);
      return jsonErr('Token de Google inválido o expirado', 401);
    }
    payload = JSON.parse(resp.getContentText());
  } catch (err) {
    console.error('tokeninfo fetch error:', err.message);
    return jsonErr('No se pudo verificar el token', 500);
  }

  // Verificar audience (client_id)
  if (cfg.clientId && payload.aud !== cfg.clientId) {
    return jsonErr('Token no emitido para esta aplicación', 401);
  }

  // Verificar expiración
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && parseInt(payload.exp) < now) {
    return jsonErr('Token de Google expirado', 401);
  }

  // Email verificado
  if (payload.email_verified !== 'true' && payload.email_verified !== true) {
    return jsonErr('Email de Google no verificado', 401);
  }

  const email = (payload.email || '').toLowerCase();
  const name  = payload.name  || payload.email || 'Usuario';

  // Determinar rol
  let role = null;
  if (cfg.adminEmails.includes(email))  role = 'admin';
  if (cfg.viewerEmails.includes(email)) role = 'viewer';

  if (!role) {
    console.warn('Acceso denegado para email:', email);
    return jsonErr('Email no autorizado. Contacta al administrador.', 403);
  }

  // Emitir token de sesión
  const sessionToken = crearTokenSesion({ email, name, role }, cfg);
  return jsonOk({ session_token: sessionToken, role, name, email });
}

// ──────────────────────────────────────────────────────────────────
//  TOKENS DE SESIÓN (HMAC-SHA256 simplificado con Utilities)
// ──────────────────────────────────────────────────────────────────
function crearTokenSesion(payload, cfg) {
  const exp = Date.now() + cfg.ttlHours * 3600 * 1000;
  const data = JSON.stringify({ ...payload, exp, iat: Date.now() });
  const encoded = Utilities.base64Encode(data);
  const sig = firmar(encoded, cfg.secret);
  return encoded + '.' + sig;
}

function verificarSesion(token) {
  if (!token) return { ok: false, error: 'Token de sesión requerido' };
  const cfg = getConfig();
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, error: 'Token malformado' };
  const [encoded, sig] = parts;
  const expectedSig = firmar(encoded, cfg.secret);
  if (sig !== expectedSig) return { ok: false, error: 'Firma de sesión inválida' };
  let payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64Decode(encoded)).getDataAsString());
  } catch {
    return { ok: false, error: 'Token no decodificable' };
  }
  if (payload.exp < Date.now()) return { ok: false, error: 'Sesión expirada. Inicia sesión nuevamente.' };
  return { ok: true, ...payload };
}

function firmar(data, secret) {
  const key  = Utilities.computeHmacSha256Signature(data, secret);
  return Utilities.base64Encode(key).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function verificarRol(auth, rolesPermitidos) {
  if (!rolesPermitidos.includes(auth.role)) throw new Error('FORBIDDEN');
}

// ──────────────────────────────────────────────────────────────────
//  OPERACIONES SHEETS
// ──────────────────────────────────────────────────────────────────
function getSheet(name) {
  const cfg = getConfig();
  const ss = cfg.sheetId
    ? SpreadsheetApp.openById(cfg.sheetId)
    : SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    // Cabeceras según hoja
    if (name === 'Registros') {
      sheet.appendRow(['id','ts','fecha','porteria','movimiento','tipo','vehiculo','placa','conductor','guarda','visitaA','obs','quickFrom']);
    } else if (name === 'Recurrentes') {
      sheet.appendRow(['id','placa','conductor','tipo','vehiculo']);
    } else if (name === 'AuditLog') {
      sheet.appendRow(['ts','email','role','accion','detalle']);
    }
  }
  return sheet;
}

function obtenerRegistros(porteria) {
  const sheet = getSheet('Registros');
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { registros: [] };
  const [headers, ...rows] = data;
  let registros = rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? String(row[i]) : ''; });
    return obj;
  });
  if (porteria) registros = registros.filter(r => r.porteria === porteria);
  // Más recientes primero, max 500
  registros.reverse();
  return { registros: registros.slice(0, 500) };
}

function obtenerRecurrentes() {
  const sheet = getSheet('Recurrentes');
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return { recurrentes: [] };
  const [headers, ...rows] = data;
  const recurrentes = rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? String(row[i]) : ''; });
    return obj;
  });
  return { recurrentes };
}

function guardarRegistro(rec, auth) {
  const sheet = getSheet('Registros');
  const now = new Date();
  sheet.appendRow([
    rec.id        || genId(),
    rec.ts        || now.toISOString(),
    rec.fecha     || now.toLocaleString('es-CO'),
    rec.porteria  || '',
    rec.movimiento|| 'ingreso',
    rec.tipo      || '',
    rec.vehiculo  || '',
    (rec.placa    || '').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6),
    rec.conductor || '',
    rec.guarda    || '',
    rec.visitaA   || '',
    rec.obs       || '',
    rec.quickFrom || '',
  ]);
  auditLog(auth.email, auth.role, 'registro', `${rec.movimiento} ${rec.placa}`);
  return { ok: true };
}

function agregarRecurrente(v) {
  const sheet = getSheet('Recurrentes');
  sheet.appendRow([v.id || genId(), v.placa || '', v.conductor || '', v.tipo || '', v.vehiculo || '']);
  return { ok: true };
}

function eliminarRecurrente(id) {
  if (!id) return { ok: false };
  const sheet = getSheet('Recurrentes');
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, error: 'No encontrado' };
}

function auditLog(email, role, accion, detalle) {
  try {
    getSheet('AuditLog').appendRow([new Date().toISOString(), email, role, accion, detalle]);
  } catch(e) { /* no bloquear */ }
}

// ──────────────────────────────────────────────────────────────────
//  HELPERS
// ──────────────────────────────────────────────────────────────────
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function jsonOk(data) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, ...data }))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonErr(msg, _code) {
  // GAS no soporta códigos HTTP en respuesta, se incluye en el body
  return ContentService
    .createTextOutput(JSON.stringify({ ok: false, error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}
