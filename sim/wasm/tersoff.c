/**
 * Tersoff (1988) force kernel for carbon — Wasm implementation.
 *
 * Line-for-line port of the JS on-the-fly distance kernel in page/js/physics.js.
 * Uses CSR neighbor list format instead of per-atom arrays.
 * Compiled with Emscripten: emcc -O3 -s WASM=1 ...
 */
#include <math.h>

/* Tersoff (1988) carbon parameters */
static const double LAMBDA1 = 3.4879;
static const double LAMBDA2 = 2.2119;
static const double T_A = 1393.6;
static const double T_B = 346.74;
static const double T_N = 0.72751;
static const double BETA = 1.5724e-7;
static const double T_C = 38049.0;
static const double T_D = 4.3484;
static const double T_H = -0.57058;
static const double R_CUT = 1.95;
static const double D_CUT = 0.15;
static const double R_MAX = 1.95 + 0.15; /* R_CUT + D_CUT = 2.10 */

/* Pre-computed constants */
static const double C2 = 38049.0 * 38049.0;
static const double D2 = 4.3484 * 4.3484;
static const double C2_D2 = (38049.0 * 38049.0) / (4.3484 * 4.3484);

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static const double HALF_PI_OVER_D = M_PI / (2.0 * 0.15);
static const double INV_2N = -1.0 / (2.0 * 0.72751);

void computeTersoffForces(
    const double* pos,
    double* force,
    const int* nlOffsets,
    const int* nlData,
    int n
) {
    const double R_MAX_SQ = R_MAX * R_MAX;

    for (int i = 0; i < n; i++) {
        int ix = i * 3;
        double pix = pos[ix], piy = pos[ix+1], piz = pos[ix+2];
        int iStart = nlOffsets[i], iEnd = nlOffsets[i+1];

        for (int qi = iStart; qi < iEnd; qi++) {
            int j = nlData[qi];
            if (j <= i) continue;
            int jx = j * 3;
            double dij_x = pos[jx] - pix, dij_y = pos[jx+1] - piy, dij_z = pos[jx+2] - piz;
            double r_ij_sq = dij_x*dij_x + dij_y*dij_y + dij_z*dij_z;
            if (r_ij_sq >= R_MAX_SQ || r_ij_sq < 1e-20) continue;
            double r_ij = sqrt(r_ij_sq);
            double inv_rij = 1.0 / r_ij;
            double rh_ij0 = dij_x*inv_rij, rh_ij1 = dij_y*inv_rij, rh_ij2 = dij_z*inv_rij;

            /* Cutoff */
            double fc_ij, dfc_ij;
            if (r_ij < R_CUT - D_CUT) { fc_ij = 1.0; dfc_ij = 0.0; }
            else {
                double arg = HALF_PI_OVER_D * (r_ij - R_CUT);
                fc_ij = 0.5 - 0.5 * sin(arg);
                dfc_ij = -0.5 * cos(arg) * HALF_PI_OVER_D;
            }

            double expL1 = exp(-LAMBDA1 * r_ij);
            double expL2 = exp(-LAMBDA2 * r_ij);
            double fR_ij = T_A * expL1;
            double dfR_ij = -LAMBDA1 * fR_ij;
            double fA_ij = -T_B * expL2;
            double dfA_ij = LAMBDA2 * T_B * expL2;

            /* ── zeta_ij ── */
            double zeta_ij = 0.0;
            for (int qk = iStart; qk < iEnd; qk++) {
                int k = nlData[qk];
                if (k == j) continue;
                int kx3 = k * 3;
                double dik_x = pos[kx3] - pix, dik_y = pos[kx3+1] - piy, dik_z = pos[kx3+2] - piz;
                double r_ik_sq = dik_x*dik_x + dik_y*dik_y + dik_z*dik_z;
                if (r_ik_sq < 1e-20 || r_ik_sq >= R_MAX_SQ) continue;
                double r_ik = sqrt(r_ik_sq);
                double inv_rik = 1.0 / r_ik;
                double rk0 = dik_x*inv_rik, rk1 = dik_y*inv_rik, rk2 = dik_z*inv_rik;

                double fc_ik;
                if (r_ik < R_CUT - D_CUT) fc_ik = 1.0;
                else fc_ik = 0.5 - 0.5 * sin(HALF_PI_OVER_D * (r_ik - R_CUT));

                double cosT = rh_ij0*rk0 + rh_ij1*rk1 + rh_ij2*rk2;
                if (cosT > 1.0) cosT = 1.0; else if (cosT < -1.0) cosT = -1.0;

                double hmc = T_H - cosT;
                zeta_ij += fc_ik * (1.0 + C2_D2 - C2 / (D2 + hmc*hmc));
            }

            /* ── zeta_ji ── */
            double zeta_ji = 0.0;
            double rh_ji0 = -rh_ij0, rh_ji1 = -rh_ij1, rh_ji2 = -rh_ij2;
            double pjx = pos[jx], pjy = pos[jx+1], pjz = pos[jx+2];
            int jStart = nlOffsets[j], jEnd = nlOffsets[j+1];

            for (int qk = jStart; qk < jEnd; qk++) {
                int k = nlData[qk];
                if (k == i) continue;
                int kx3 = k * 3;
                double djk_x = pos[kx3] - pjx, djk_y = pos[kx3+1] - pjy, djk_z = pos[kx3+2] - pjz;
                double r_jk_sq = djk_x*djk_x + djk_y*djk_y + djk_z*djk_z;
                if (r_jk_sq < 1e-20 || r_jk_sq >= R_MAX_SQ) continue;
                double r_jk = sqrt(r_jk_sq);
                double inv_rjk = 1.0 / r_jk;
                double rk0 = djk_x*inv_rjk, rk1 = djk_y*inv_rjk, rk2 = djk_z*inv_rjk;

                double fc_jk;
                if (r_jk < R_CUT - D_CUT) fc_jk = 1.0;
                else fc_jk = 0.5 - 0.5 * sin(HALF_PI_OVER_D * (r_jk - R_CUT));

                double cosT = rh_ji0*rk0 + rh_ji1*rk1 + rh_ji2*rk2;
                if (cosT > 1.0) cosT = 1.0; else if (cosT < -1.0) cosT = -1.0;

                double hmc = T_H - cosT;
                zeta_ji += fc_jk * (1.0 + C2_D2 - C2 / (D2 + hmc*hmc));
            }

            /* ── Bond orders ── */
            double bz_ij = BETA * zeta_ij;
            double bij = bz_ij > 0 ? pow(1.0 + pow(bz_ij, T_N), INV_2N) : 1.0;
            double bz_ji = BETA * zeta_ji;
            double bji = bz_ji > 0 ? pow(1.0 + pow(bz_ji, T_N), INV_2N) : 1.0;

            /* ── Pair forces ── */
            double pf_ij = 0.5 * (dfc_ij*(fR_ij + bij*fA_ij) + fc_ij*(dfR_ij + bij*dfA_ij));
            double pf_ji = 0.5 * (dfc_ij*(fR_ij + bji*fA_ij) + fc_ij*(dfR_ij + bji*dfA_ij));
            double pf = pf_ij + pf_ji;

            force[ix]   += pf * rh_ij0;
            force[ix+1] += pf * rh_ij1;
            force[ix+2] += pf * rh_ij2;
            force[jx]   -= pf * rh_ij0;
            force[jx+1] -= pf * rh_ij1;
            force[jx+2] -= pf * rh_ij2;

            /* ── 3-body forces from zeta_ij ── */
            if (bz_ij > 0 && zeta_ij > 0) {
                double dbij = -0.5 * BETA * pow(bz_ij, T_N - 1.0) *
                              pow(1.0 + pow(bz_ij, T_N), INV_2N - 1.0);
                double dEdz = 0.5 * fc_ij * fA_ij * dbij;

                for (int qk = iStart; qk < iEnd; qk++) {
                    int k = nlData[qk];
                    if (k == j) continue;
                    int kx3 = k * 3;
                    double dik_x = pos[kx3]-pix, dik_y = pos[kx3+1]-piy, dik_z = pos[kx3+2]-piz;
                    double r_ik_sq = dik_x*dik_x + dik_y*dik_y + dik_z*dik_z;
                    if (r_ik_sq < 1e-20 || r_ik_sq >= R_MAX_SQ) continue;
                    double r_ik = sqrt(r_ik_sq);
                    double inv_rik = 1.0 / r_ik;
                    double rk0 = dik_x*inv_rik, rk1 = dik_y*inv_rik, rk2 = dik_z*inv_rik;

                    double fc_ik, dfc_ik;
                    if (r_ik < R_CUT - D_CUT) { fc_ik = 1.0; dfc_ik = 0.0; }
                    else {
                        double arg = HALF_PI_OVER_D * (r_ik - R_CUT);
                        fc_ik = 0.5 - 0.5 * sin(arg);
                        dfc_ik = -0.5 * cos(arg) * HALF_PI_OVER_D;
                    }

                    double cosT = rh_ij0*rk0 + rh_ij1*rk1 + rh_ij2*rk2;
                    if (cosT > 1.0) cosT = 1.0; else if (cosT < -1.0) cosT = -1.0;

                    double hmc = T_H - cosT;
                    double denom = D2 + hmc*hmc;
                    double g_val = 1.0 + C2_D2 - C2 / denom;
                    double dg_val = -2.0 * C2 * hmc / (denom * denom);

                    /* d=0,1,2 loop */
                    double rij_d, rik_d, dcos_drj, dcos_drk, dcos_dri;

                    /* d=0 */
                    rij_d = rh_ij0; rik_d = rk0;
                    dcos_drj = (rik_d - cosT*rij_d)*inv_rij;
                    dcos_drk = (rij_d - cosT*rik_d)*inv_rik;
                    dcos_dri = -(dcos_drj + dcos_drk);
                    force[ix]   -= dEdz*(dfc_ik*(-rik_d)*g_val + fc_ik*dg_val*dcos_dri);
                    force[jx]   -= dEdz*fc_ik*dg_val*dcos_drj;
                    force[kx3]  -= dEdz*(dfc_ik*rik_d*g_val + fc_ik*dg_val*dcos_drk);

                    /* d=1 */
                    rij_d = rh_ij1; rik_d = rk1;
                    dcos_drj = (rik_d - cosT*rij_d)*inv_rij;
                    dcos_drk = (rij_d - cosT*rik_d)*inv_rik;
                    dcos_dri = -(dcos_drj + dcos_drk);
                    force[ix+1]   -= dEdz*(dfc_ik*(-rik_d)*g_val + fc_ik*dg_val*dcos_dri);
                    force[jx+1]   -= dEdz*fc_ik*dg_val*dcos_drj;
                    force[kx3+1]  -= dEdz*(dfc_ik*rik_d*g_val + fc_ik*dg_val*dcos_drk);

                    /* d=2 */
                    rij_d = rh_ij2; rik_d = rk2;
                    dcos_drj = (rik_d - cosT*rij_d)*inv_rij;
                    dcos_drk = (rij_d - cosT*rik_d)*inv_rik;
                    dcos_dri = -(dcos_drj + dcos_drk);
                    force[ix+2]   -= dEdz*(dfc_ik*(-rik_d)*g_val + fc_ik*dg_val*dcos_dri);
                    force[jx+2]   -= dEdz*fc_ik*dg_val*dcos_drj;
                    force[kx3+2]  -= dEdz*(dfc_ik*rik_d*g_val + fc_ik*dg_val*dcos_drk);
                }
            }

            /* ── 3-body forces from zeta_ji ── */
            if (bz_ji > 0 && zeta_ji > 0) {
                double dbji = -0.5 * BETA * pow(bz_ji, T_N - 1.0) *
                              pow(1.0 + pow(bz_ji, T_N), INV_2N - 1.0);
                double dEdz = 0.5 * fc_ij * fA_ij * dbji;

                for (int qk = jStart; qk < jEnd; qk++) {
                    int k = nlData[qk];
                    if (k == i) continue;
                    int kx3 = k * 3;
                    double djk_x = pos[kx3]-pjx, djk_y = pos[kx3+1]-pjy, djk_z = pos[kx3+2]-pjz;
                    double r_jk_sq = djk_x*djk_x + djk_y*djk_y + djk_z*djk_z;
                    if (r_jk_sq < 1e-20 || r_jk_sq >= R_MAX_SQ) continue;
                    double r_jk = sqrt(r_jk_sq);
                    double inv_rjk = 1.0 / r_jk;
                    double rk0 = djk_x*inv_rjk, rk1 = djk_y*inv_rjk, rk2 = djk_z*inv_rjk;

                    double fc_jk, dfc_jk;
                    if (r_jk < R_CUT - D_CUT) { fc_jk = 1.0; dfc_jk = 0.0; }
                    else {
                        double arg = HALF_PI_OVER_D * (r_jk - R_CUT);
                        fc_jk = 0.5 - 0.5 * sin(arg);
                        dfc_jk = -0.5 * cos(arg) * HALF_PI_OVER_D;
                    }

                    double cosT = rh_ji0*rk0 + rh_ji1*rk1 + rh_ji2*rk2;
                    if (cosT > 1.0) cosT = 1.0; else if (cosT < -1.0) cosT = -1.0;

                    double hmc = T_H - cosT;
                    double denom = D2 + hmc*hmc;
                    double g_val = 1.0 + C2_D2 - C2 / denom;
                    double dg_val = -2.0 * C2 * hmc / (denom * denom);

                    double rji_d, rjk_d, dcos_dri, dcos_drk, dcos_drj;

                    /* d=0 */
                    rji_d = rh_ji0; rjk_d = rk0;
                    dcos_dri = (rjk_d - cosT*rji_d)*inv_rij;
                    dcos_drk = (rji_d - cosT*rjk_d)*inv_rjk;
                    dcos_drj = -(dcos_dri + dcos_drk);
                    force[jx]   -= dEdz*(dfc_jk*(-rjk_d)*g_val + fc_jk*dg_val*dcos_drj);
                    force[ix]   -= dEdz*fc_jk*dg_val*dcos_dri;
                    force[kx3]  -= dEdz*(dfc_jk*rjk_d*g_val + fc_jk*dg_val*dcos_drk);

                    /* d=1 */
                    rji_d = rh_ji1; rjk_d = rk1;
                    dcos_dri = (rjk_d - cosT*rji_d)*inv_rij;
                    dcos_drk = (rji_d - cosT*rjk_d)*inv_rjk;
                    dcos_drj = -(dcos_dri + dcos_drk);
                    force[jx+1]   -= dEdz*(dfc_jk*(-rjk_d)*g_val + fc_jk*dg_val*dcos_drj);
                    force[ix+1]   -= dEdz*fc_jk*dg_val*dcos_dri;
                    force[kx3+1]  -= dEdz*(dfc_jk*rjk_d*g_val + fc_jk*dg_val*dcos_drk);

                    /* d=2 */
                    rji_d = rh_ji2; rjk_d = rk2;
                    dcos_dri = (rjk_d - cosT*rji_d)*inv_rij;
                    dcos_drk = (rji_d - cosT*rjk_d)*inv_rjk;
                    dcos_drj = -(dcos_dri + dcos_drk);
                    force[jx+2]   -= dEdz*(dfc_jk*(-rjk_d)*g_val + fc_jk*dg_val*dcos_drj);
                    force[ix+2]   -= dEdz*fc_jk*dg_val*dcos_dri;
                    force[kx3+2]  -= dEdz*(dfc_jk*rjk_d*g_val + fc_jk*dg_val*dcos_drk);
                }
            }
        }
    }
}
