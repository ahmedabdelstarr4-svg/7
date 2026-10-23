// @ts-nocheck
/* ==========================================================================
   المحرك الرئيسي للنظام المالي الشخصي - app.js
   يحتوي على إدارة قاعدة البيانات (IndexedDB)، الإعدادات (LocalStorage)،
   والنسخ الاحتياطي الشامل والاستعادة.
   ========================================================================== */

const DB_NAME = "PersonalFinanceDB";
const DB_VERSION = 1;
const STORE_NAME = "transactions";

// مفاتيح التخزين المحلي للإعدادات
const PEOPLE_KEY = "pf_people_list";
const EXPENSE_CATS_KEY = "pf_expense_cats_list";
const SAFETY_CAP_KEY = "pf_safety_cap";
const TARGET_PCT_KEY = "pf_target_percentages";
const ACCOUNTS_KEY = "pf_accounts_list";
const SETUP_DONE_KEY = "pf_setup_done";
const OUTSIDE_ACCOUNT_ID = "outside";

let dbInstance = null;

/* --------------------------------------------------------------------------
   1. إدارة قاعدة البيانات (IndexedDB)
   -------------------------------------------------------------------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    if (dbInstance) return resolve(dbInstance);
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("date", "date", { unique: false });
      }
    };

    request.onsuccess = (e) => {
      dbInstance = e.target.result;
      resolve(dbInstance);
    };

    request.onerror = (e) => reject(e.target.error);
  });
}

async function getAllTransactions() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      const records = (request.result || []).map((item) => {
        if (item && item.date && item.date.split("-").length === 3) {
          item.date = formatStrictISO(...item.date.split("-"));
        }
        return item;
      });
      // ترتيب تنازلي حسب التاريخ والوقت
      records.sort((a, b) => 
        (b.date || "").localeCompare(a.date || "") || 
        (b.time || "").localeCompare(a.time || "") || 
        (b.id || "").localeCompare(a.id || "")
      );
      resolve(records);
    };

    request.onerror = () => reject(request.error);
  });
}

async function saveTransactionRecord(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(record);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteTransactionRecord(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function clearAllTransactionsStore() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

/* --------------------------------------------------------------------------
   2. إدارة الحسابات والمحافظ
   -------------------------------------------------------------------------- */

function getAccountsList() {
  const raw = localStorage.getItem(ACCOUNTS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (e) {
      console.warn("خطأ قراءة الحسابات:", e);
    }
  }
  return [
    { id: "cash_default", name: "الكاش (في جيبي)", type: "cash", icon: "💵" },
    { id: "bank_default", name: "الحساب البنكي", type: "bank", icon: "🏦" },
    { id: OUTSIDE_ACCOUNT_ID, name: "خارج النظام (بداية)", type: "outside", icon: "🌐", hidden: true }
  ];
}

function saveAccountsList(list) {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(list));
}

function getVisibleAccounts() {
  return getAccountsList().filter((a) => !a.hidden && a.id !== OUTSIDE_ACCOUNT_ID);
}

function getAccountById(id) {
  if (!id) return getAccountsList()[0];
  return getAccountsList().find((a) => a.id === id) || getAccountsList()[0];
}

function calculateAccountBalance(transactions, accountId) {
  let balance = 0;
  (transactions || []).forEach((tx) => {
    if (tx.type === "internal_transfer") {
      if (tx.account === accountId) balance -= getRealAmount(tx);
      if (tx.toAccount === accountId) balance += getRealAmount(tx);
      return;
    }
    const acc = tx.account || "cash_default";
    if (acc !== accountId) return;

    if (tx.type === "income" || isCreditor(tx)) {
      balance += getRealAmount(tx);
    } else if (tx.type === "expense" || tx.type === "transfer" || isDebtor(tx)) {
      balance -= getRealAmount(tx);
    }
  });
  return balance;
}

/* --------------------------------------------------------------------------
   3. إدارة قائمة الأسماء وتصنيفات المصروفات وسقف اليوم والمستهدفات
   -------------------------------------------------------------------------- */

function getPeopleList() {
  const raw = localStorage.getItem(PEOPLE_KEY);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function savePeopleList(list) {
  const unique = [...new Set(list)];
  localStorage.setItem(PEOPLE_KEY, JSON.stringify(unique));
}

function getExpenseCategories() {
  const raw = localStorage.getItem(EXPENSE_CATS_KEY);
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    } catch (e) {}
  }
  return ["أدوات ومشتريات شخصية", "نثريات ومتفرقات", "طعام ومأكولات", "مصاريف منزلية"];
}

function saveExpenseCategories(list) {
  const unique = [...new Set(list)];
  localStorage.setItem(EXPENSE_CATS_KEY, JSON.stringify(unique));
}

function getIncomeCategories() {
  return ["راتب أساسي", "عمل إضافي", "أرباح / عوائد", "أخرى"];
}

function getSafetyCap() {
  return Number(localStorage.getItem(SAFETY_CAP_KEY)) || 150;
}

function saveSafetyCapValue(val) {
  localStorage.setItem(SAFETY_CAP_KEY, Number(val) || 150);
}

function getTargetPercentages() {
  const raw = localStorage.getItem(TARGET_PCT_KEY);
  if (raw) {
    try { return JSON.parse(raw); } catch (e) {}
  }
  return { fixed: 30, regular: 30, personal: 10, transfer: 20, debt: 10 };
}

function saveTargetPercentages(obj) {
  localStorage.setItem(TARGET_PCT_KEY, JSON.stringify(obj));
}

/* --------------------------------------------------------------------------
   4. دوال حسابية وتنسيقية مساعدة
   -------------------------------------------------------------------------- */

function getRealAmount(tx) {
  if (!tx) return 0;
  if (tx.type === "transfer" || tx.type === "internal_transfer") {
    return Number(tx.totalKwd ?? tx.amount) || 0;
  }
  return Number(tx.amount) || 0;
}

function isCreditor(tx) { return tx.type === "debt" && tx.debtType === "creditor"; }
function isDebtor(tx) { return tx.type === "debt" && tx.debtType === "debtor"; }
function isOpeningDebt(tx) { return tx.type === "debt" && tx.debtType === "opening_balance"; }

function formatMoney(amount, currency = "د.ك") {
  return Number(amount || 0).toFixed(3) + " " + currency;
}

function formatMoneyEGP(amount) {
  return Number(amount || 0).toLocaleString("en-US", { maximumFractionDigits: 0 }) + " ج.م";
}

function formatStrictISO(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function todayISO() {
  const d = new Date();
  return formatStrictISO(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function firstOfMonthISO() {
  const d = new Date();
  return formatStrictISO(d.getFullYear(), d.getMonth() + 1, 1);
}

function formatDateDisplay(isoStr) {
  if (!isoStr) return "";
  const parts = isoStr.split("-");
  if (parts.length < 3) return isoStr;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function showToastMessage(msg) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.style.display = "block";
  setTimeout(() => { toast.style.display = "none"; }, 3500);
}

function escapeHTMLString(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* --------------------------------------------------------------------------
   5. دوال الدورات المالية (Salary Cycles)
   -------------------------------------------------------------------------- */

function getPreviousDay(isoDate) {
  const parts = isoDate.split("-");
  const d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  d.setUTCDate(d.getUTCDate() - 1);
  return formatStrictISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function isTxInCycle(tx, cycle) {
  if (!tx || !tx.date || !cycle || !cycle.start || !cycle.end) return false;
  const d = formatStrictISO(...tx.date.split("-"));
  return d >= cycle.start && d <= cycle.end;
}

function getAllSalaryCycles(transactions) {
  const today = todayISO();
  const validTxs = (transactions || []).filter((t) => t && t.date);
  const salaryDates = [...new Set(
    validTxs.filter((t) => t.type === "income" && t.isSalaryBase).map((t) => t.date).sort()
  )];

  const cycles = [];
  if (!salaryDates.length) {
    const sortedDates = validTxs.map((t) => t.date).sort();
    const startDate = sortedDates.length ? sortedDates[0] : firstOfMonthISO();
    cycles.push({
      id: `cycle_${startDate}_${today}`,
      label: `الدورة الحالية (${formatDateDisplay(startDate)} ← اليوم)`,
      start: startDate,
      end: today,
      isCurrent: true,
      cycleIndex: 1
    });
    return cycles;
  }

  const firstSalary = salaryDates[0];
  const priorTxs = validTxs.filter((t) => t.date < firstSalary);
  if (priorTxs.length > 0) {
    priorTxs.sort((a, b) => a.date.localeCompare(b.date));
    const startPrior = priorTxs[0].date;
    const endPrior = getPreviousDay(firstSalary);
    cycles.push({
      id: `cycle_prior_${startPrior}_${endPrior}`,
      label: `الأرصدة والتسويات القديمة (${formatDateDisplay(startPrior)} ← ${formatDateDisplay(endPrior)})`,
      start: startPrior,
      end: endPrior,
      isCurrent: false,
      isPriorPeriod: true
    });
  }

  for (let i = 0; i < salaryDates.length; i++) {
    const sDate = salaryDates[i];
    const isLast = i === salaryDates.length - 1;
    const eDate = isLast ? today : getPreviousDay(salaryDates[i + 1]);
    const idx = i + 1;
    cycles.push({
      id: `cycle_${sDate}_${eDate}`,
      label: isLast
        ? `الدورة الحالية ${idx} (${formatDateDisplay(sDate)} ← اليوم)`
        : `دورة ${idx} (${formatDateDisplay(sDate)} ← ${formatDateDisplay(eDate)})`,
      start: sDate,
      end: eDate,
      isCurrent: isLast,
      cycleIndex: idx
    });
  }
  return cycles;
}

/* --------------------------------------------------------------------------
   6. النسخ الاحتياطي الشامل والاستعادة (JSON)
   -------------------------------------------------------------------------- */

async function buildFullBackupData() {
  const txs = await getAllTransactions();
  return {
    version: 15,
    savedAt: new Date().toISOString(),
    transactions: txs,
    people: getPeopleList(),
    expenseCategories: getExpenseCategories(),
    accounts: getAccountsList(),
    safetyCap: getSafetyCap(),
    targetPercentages: getTargetPercentages()
  };
}

async function restoreFullBackupData(jsonData) {
  if (!jsonData || typeof jsonData !== "object") {
    throw new Error("ملف النسخة غير صالحة");
  }

  const txs = Array.isArray(jsonData.transactions) ? jsonData.transactions : [];
  
  // 1. تفريغ وإعادة كتابة المعاملات
  await clearAllTransactionsStore();
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);

  txs.forEach((item) => {
    if (item && item.date) {
      const parts = item.date.split("-");
      if (parts.length === 3) {
        item.date = formatStrictISO(parts[0], parts[1], parts[2]);
      }
    }
    store.put(item);
  });

  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });

  // 2. استعادة كافة الإعدادات
  if (Array.isArray(jsonData.people)) savePeopleList(jsonData.people);
  if (Array.isArray(jsonData.expenseCategories)) saveExpenseCategories(jsonData.expenseCategories);
  if (Array.isArray(jsonData.accounts) && jsonData.accounts.length) saveAccountsList(jsonData.accounts);
  if (jsonData.safetyCap) saveSafetyCapValue(jsonData.safetyCap);
  if (jsonData.targetPercentages) saveTargetPercentages(jsonData.targetPercentages);

  localStorage.setItem(SETUP_DONE_KEY, "1");
  return true;
}
