// =====================================================================
// lib/payroll.js — PAYROLL COMPUTE ENGINE (Phase 4)
// Statutory rates are DATA, read EFFECTIVE FOR THE RUN's period_month (never
// "latest"), so a historical payslip reconciles even after a rate change.
// v1 simplification (ruling): incentives are a separate earning added
// post-statutory — NOT run through PF/PT/ESI. TDS is a manual figure.
// =====================================================================
const pool = require('../db');

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;  // 2dp
const rupee = (n) => Math.round(Number(n));                              // nearest rupee (PF/ESI convention)

// Effective scalar statutory rates for a period (latest effective_from <= period).
async function getEffectiveRates(periodMonth) {
    const { rows } = await pool.query(
        `SELECT DISTINCT ON (rate_key) rate_key, value
           FROM private.statutory_rates
          WHERE active AND deleted_at IS NULL AND effective_from <= $1
          ORDER BY rate_key, effective_from DESC`,
        [periodMonth]);
    const m = {};
    for (const row of rows) m[row.rate_key] = Number(row.value);
    return m;
}

// Effective PT slab SET for a period (the newest effective_from <= period).
async function getEffectivePtSlabs(periodMonth, state = 'MH') {
    const { rows } = await pool.query(
        `SELECT lower_gross, upper_gross, monthly_amount, feb_amount
           FROM private.pt_slabs
          WHERE state = $2 AND active AND deleted_at IS NULL AND effective_from <= $1
            AND effective_from = (SELECT MAX(effective_from) FROM private.pt_slabs
                                   WHERE state = $2 AND active AND deleted_at IS NULL AND effective_from <= $1)
          ORDER BY lower_gross`,
        [periodMonth, state]);
    return rows;
}

// PT for a gross, honouring the MH February quirk.
function professionalTax(gross, ptSlabs, isFeb) {
    for (const s of ptSlabs) {
        const lo = Number(s.lower_gross), hi = s.upper_gross == null ? null : Number(s.upper_gross);
        if (gross > lo && (hi === null || gross <= hi)) {
            const feb = s.feb_amount == null ? null : Number(s.feb_amount);
            return (isFeb && feb != null) ? feb : Number(s.monthly_amount);
        }
    }
    return 0;
}

// Pure compute. structure = {basic,hra,allowances,monthly_tds_default}. rates =
// map from getEffectiveRates. ptSlabs from getEffectivePtSlabs. incentiveTotal =
// sum of payable incentives this month. tdsOverride = null -> use structure default.
function computePayslip({ structure, rates, ptSlabs, incentiveTotal = 0, tdsOverride = null, periodMonth }) {
    const basic = Number(structure.basic) || 0;
    const hra = Number(structure.hra) || 0;
    const allow = Number(structure.allowances) || 0;
    const gross = r2(basic + hra + allow);

    // PF on basic, capped at the wage ceiling.
    const ceiling = rates.pf_wage_ceiling != null ? rates.pf_wage_ceiling : Infinity;
    const pfBase = Math.min(basic, ceiling);
    const pf_employee = rupee(pfBase * (rates.pf_employee_pct || 0) / 100);
    const pf_employer = rupee(pfBase * (rates.pf_employer_pct || 0) / 100);

    // ESI only if gross <= threshold; on gross.
    const esiApplies = rates.esi_gross_threshold != null && gross <= rates.esi_gross_threshold;
    const esi_employee = esiApplies ? rupee(gross * (rates.esi_employee_pct || 0) / 100) : 0;
    const esi_employer = esiApplies ? rupee(gross * (rates.esi_employer_pct || 0) / 100) : 0;

    // PT on gross (Feb quirk). periodMonth is a Date or 'YYYY-MM-DD'.
    const monthNo = periodMonth instanceof Date ? periodMonth.getMonth() + 1 : Number(String(periodMonth).slice(5, 7));
    const professional_tax = r2(professionalTax(gross, ptSlabs, monthNo === 2));

    const tds = r2(tdsOverride != null ? tdsOverride : (structure.monthly_tds_default || 0));
    const incentive = r2(incentiveTotal || 0);

    const total_deductions = r2(pf_employee + esi_employee + professional_tax + tds);
    const net_pay = r2(gross + incentive - total_deductions);

    return {
        basic: r2(basic), hra: r2(hra), allowances: r2(allow), gross,
        incentive_amount: incentive,
        pf_employee, esi_employee, professional_tax, tds,
        total_deductions, net_pay,
        pf_employer, esi_employer,
    };
}

module.exports = { getEffectiveRates, getEffectivePtSlabs, computePayslip, professionalTax, r2, rupee };
