# Software Development & Deployment Agreement

**Project:** Multi-Tenant Solar Portfolio Monitoring Platform ("SolarCMS")

This Agreement ("Agreement") is made and entered into on **[Effective Date]**, at **[City]**, India, by and between:

**[Vendor Legal Name]**, a [proprietorship / partnership / private limited company] having its registered office at [Vendor Address], PAN: [PAN], GSTIN: [GSTIN] (hereinafter referred to as the **"Developer"**, which expression shall, unless repugnant to the context, include its successors and permitted assigns),

**AND**

**[Client Legal Name]**, a [company / proprietorship / partnership] having its registered office at [Client Address], PAN: [PAN], GSTIN: [GSTIN] (hereinafter referred to as the **"Client"**, which expression shall, unless repugnant to the context, include its successors and permitted assigns).

The Developer and the Client are hereinafter individually referred to as a **"Party"** and collectively as the **"Parties."**

---

## 1. Recitals

1.1 The Client operates a business of managing and monitoring solar power generation assets on behalf of third-party plant owners ("Client's End Customers") and wishes to commission a software platform to remotely monitor, manage, and report on such solar assets across its portfolio.

1.2 The Developer is engaged in the business of designing, developing, and deploying software platforms and has represented to the Client that it possesses the necessary skill, expertise, and resources to design, develop, test, and deploy the platform described in this Agreement.

1.3 Relying on the representations of the Developer, the Client wishes to engage the Developer, and the Developer agrees to be engaged, on the terms and conditions set out below.

---

## 2. Definitions

2.1 **"Platform"** means the multi-tenant solar plant monitoring software system described in Schedule A, comprising the backend services, database, APIs, and web-based frontend application, together with all associated source code, configuration, and documentation delivered under this Agreement.

2.2 **"Deliverables"** means the Platform and all outputs specified in Schedule A that the Developer is required to design, build, test, and hand over to the Client under this Agreement.

2.3 **"Go-Live" or "Handover"** means the date on which the Platform is deployed to the Client's production environment and made available for the Client's live operational use.

2.4 **"Staging Environment"** means a pre-production environment, functionally equivalent to production, made available to the Client for User Acceptance Testing (UAT) prior to Go-Live.

2.5 **"Bug"** means a demonstrable failure of the Platform to perform in accordance with the functional specification agreed under Schedule A — i.e., the software does not do what was specified.

2.6 **"Change Request" or "New Feature"** means any requirement, functionality, integration, workflow, or modification not documented in Schedule A as of the date of this Agreement, including but not limited to new modules, new report types, new user roles, new third-party integrations, or a change in the scale/capacity parameters in Schedule B.

2.7 **"Confidential Information"** has the meaning given in Clause 12.

---

## 3. Schedule A — Technical Deliverables (Scope of Work)

The Developer shall design, develop, test, and deploy a multi-tenant solar plant monitoring platform comprising the following:

### 3.1 Data Ingestion Layer
- MQTT-based ingestion pipeline to receive telemetry from field devices (inverters, meters, weather stations, transformers, and other solar-plant equipment) across the Client's registered plants.
- Decoding and normalization of incoming device payloads into a structured, time-series data model.
- Automated device/topic discovery tooling to assist onboarding of new plants and devices.

### 3.2 Data Storage & Retention
- Time-series database (TimescaleDB) storing raw readings and pre-computed aggregates (minute / 15-minute / hourly / daily rollups) to support both real-time dashboards and historical reporting.
- A tiered retention policy balancing storage cost against reporting needs (raw data retained short-term, aggregates retained long-term).

### 3.3 Multi-Tenant Access Control
- Client-level data isolation such that each of the Client's End Customers (tenants) can only access their own plant data.
- Role-based access control (Platform Super Admin, Client Admin, and other roles as mutually agreed) governing what each user type can view and edit.

### 3.4 Application Programming Interfaces
- REST API covering plant, device, user, and reporting operations.
- WebSocket-based live-update channel for real-time dashboard refresh, scoped per tenant.

### 3.5 Web Application — Dashboards & Monitoring
- **Portfolio Dashboard:** fleet-level view across all plants under the Client's management, showing key generation and health metrics per plant.
- **Single-Plant Dashboard:** a fixed, configuration-driven KPI screen per plant (current power, energy generated, Performance Ratio, CUF, availability, and comparable metrics), with per-plant differences in equipment/metering handled through configuration, not custom code per plant.
- **Single Line Diagram (SLD):** a visual, auto-generated electrical hierarchy view (PV Array → Inverters → Transformer → Grid) per plant, reflecting how each plant's equipment is actually wired.
- **Alarms:** automated fault/anomaly detection (e.g., device offline, values out of expected range, underperformance) with configurable thresholds, and an alarm inbox/history per tenant.
- **Reports:** scheduled and on-demand generation of generation/performance reports over historical data.

### 3.6 Administration & Onboarding
- Admin interface for onboarding new plants, devices, and users.
- Device/plant hierarchy management (which device feeds into which, which device transmits data for which, and physical grouping) editable post-onboarding.
- Client management (creating new Client accounts/tenants with at least one login, so no tenant is ever created without access).

### 3.7 Non-Functional Requirements
Refer to **Schedule B** for the scale and performance parameters the Platform will be designed, configured, and tested against.

### 3.8 Out of Scope (unless covered by a signed Change Request under Clause 6)
- Native mobile applications (iOS/Android).
- Integration with any third-party billing, ERP, or accounting system.
- Any functionality, module, report, dashboard widget, or workflow not listed in Clause 3.1–3.6 above.
- Historical data migration from any pre-existing system of the Client, unless separately scoped and priced.
- Content/data entry (device lists, plant metadata, tag catalogues) beyond what the Client provides in machine-readable form or via live broker discovery.

---

## 4. Schedule B — Scale & Performance Parameters

The Platform shall be designed, configured, and load-tested to reliably support, at Go-Live:

| Parameter | Target |
|---|---|
| Aggregate solar portfolio capacity | Up to **300 MWp** |
| Concurrently reporting devices | Up to **250 devices** |
| Tenants (Client's End Customers) | As required by the Client's active plant count at Go-Live |
| Data ingestion interval | Per device telemetry interval as published by field equipment |
| Dashboard/API availability target | Commercially reasonable efforts basis; no uptime SLA is included in this Agreement unless separately agreed in writing |

**4.1** Scaling beyond the parameters in this Schedule B (e.g., portfolio capacity materially exceeding 300 MWp, or concurrent device count materially exceeding 250) is **not covered** by the Commercial Terms in Clause 5 and shall require a Change Request under Clause 6, which may include additional infrastructure, licensing, and development cost.

**4.2** The Client is responsible, at its own cost, for procuring and maintaining the underlying cloud/server infrastructure, MQTT broker access/credentials, domain name, and SSL certificates required to host the Platform in production, unless otherwise agreed in writing. The Developer shall size and configure the Platform for the infrastructure the Client provides.

---

## 5. Commercial Terms

### 5.1 Total Contract Value

The total value of this Agreement for the Deliverables under Schedule A is **₹8,50,000 (Rupees Eight Lakh Fifty Thousand only)**, exclusive of applicable taxes, broken down indicatively as follows:

| Work Stream | Amount (₹) | % of Total |
|---|---:|---:|
| UI/UX Design | 1,00,000 | 11.76% |
| Development (Backend + Frontend) | 5,00,000 | 58.82% |
| Testing (QA, Integration, UAT support) | 1,25,000 | 14.71% |
| Deployment (Staging + Production go-live) | 1,25,000 | 14.71% |
| **Total** | **8,50,000** | **100%** |

This breakdown is indicative of effort allocation and does **not** create independently payable milestones — payment is governed exclusively by Clause 5.2.

### 5.2 Payment Schedule

Payment shall be made in three (3) instalments, against the Total Contract Value, as follows:

| Milestone | % | Amount (₹) | Trigger |
|---|---:|---:|---|
| **Instalment 1 — Advance** | 33% | 2,80,500 | Upon signing of this Agreement, before commencement of work |
| **Instalment 2 — Staging Delivery** | 33% | 2,80,500 | Upon deployment of the Platform to the Staging Environment for UAT |
| **Instalment 3 — Handover** | 34% | 2,89,000 | Upon Go-Live / production deployment and handover |

**5.2.1** Each invoice is payable within **7 (seven) days** of the invoice date, by bank transfer to the account details specified on the invoice.

**5.2.2** Delayed payment beyond the due date shall attract interest at **1.5% per month** (or the rate prescribed under the Micro, Small and Medium Enterprises Development Act, 2006, if the Developer is MSME-registered at the relevant time, whichever is higher), calculated on a pro-rata daily basis on the overdue amount.

**5.2.3** The Developer is not obligated to commence, continue, or deliver any milestone's work while the preceding instalment remains unpaid beyond its due date, and any resulting delay to the timeline in Clause 7 shall not be attributable to the Developer.

### 5.3 Taxes

**5.3.1** The Total Contract Value is exclusive of GST. GST shall be charged additionally at the rate prevailing under the Central Goods and Services Tax Act, 2017 and the corresponding State/Integrated GST legislation, as applicable, on each invoice.

**5.3.2** The Client shall be entitled to deduct tax at source (TDS) as required under the Income Tax Act, 1961, provided the Client furnishes the Developer with a valid TDS certificate (Form 16A) for each such deduction within the timelines prescribed by law.

---

## 6. Change Requests / Out-of-Scope Work

**6.1** Any requirement that falls outside Schedule A, including any New Feature as defined in Clause 2.6, shall be handled through a written Change Request, which shall separately specify the additional scope, price, and timeline impact, and shall require both Parties' written sign-off before work commences.

**6.2** For the avoidance of doubt, the Developer is under **no obligation** to build, and the Total Contract Value in Clause 5.1 does **not** include, any New Feature outside Schedule A. This Agreement covers Schedule A only.

**6.3** A change to the scale parameters in Schedule B is treated as a Change Request under this Clause, not as a Bug.

---

## 7. Project Timeline

**7.1** Subject to Clause 5.2.3 and Clause 7.3, the Parties target the following indicative schedule, commencing from receipt of Instalment 1:

| Week | Milestone |
|---|---|
| Week 1 | Kickoff; requirements walkthrough and sign-off; UI/UX design finalization |
| Weeks 1–3 | Development of backend, frontend, and integration |
| End of Week 3 | Deployment to Staging Environment; UAT begins |
| Week 4 | UAT-reported Bug fixes; final testing; production deployment and Handover |

**7.2** This is an aggressive 4-week timeline and is contingent on the Client providing, within 2 (two) business days of request: broker/MQTT access and credentials, device/tag lists or equivalent data, timely feedback during UAT, and any other information reasonably required by the Developer. Delay in the Client's response shall extend the timeline on a day-for-day basis and shall not constitute a breach by the Developer.

**7.3** Time is not of the essence for the dates in Clause 7.1; they are planning estimates, not contractual deadlines, save that the payment triggers in Clause 5.2 remain tied to the actual completion of the relevant milestone, whenever it occurs.

---

## 8. Acceptance Testing / Sign-off

**8.1** On deployment to the Staging Environment, the Client shall carry out UAT against Schedule A and report any Bugs in writing within **5 (five) business days**.

**8.2** If the Client does not respond within the period in Clause 8.1, the Staging deployment shall be deemed accepted, and Instalment 2 shall become payable (if not already invoiced) without further reference to the Client.

**8.3** The same 5-business-day deemed-acceptance mechanism applies to Handover/Go-Live under Instalment 3.

**8.4** Acceptance testing is limited to verifying conformance with Schedule A. Requests raised during UAT that fall under Clause 2.6 (New Feature) shall be logged as Change Requests under Clause 6 and shall not delay or condition sign-off of the relevant milestone.

---

## 9. Warranty & Bug-Fixing Support

**9.1** For a period of **60 (sixty) calendar days** from the date of Handover ("Warranty Period"), the Developer shall fix, at no additional cost, any Bug (as defined in Clause 2.5) reported by the Client in writing.

**9.2** The Warranty Period covers Bugs only. It does **not** cover: (a) any New Feature or Change Request as defined in Clause 2.6; (b) issues arising from the Client's infrastructure, hosting, network, or third-party services outside the Developer's control; (c) issues caused by modification of the Platform by anyone other than the Developer; or (d) issues arising from field devices, MQTT brokers, or data sources publishing outside their documented/expected format.

**9.3** The Developer will use commercially reasonable efforts to acknowledge a reported Bug within 2 business days and to provide a fix or workaround within a reasonable time based on severity; no specific resolution-time SLA is included unless separately agreed in writing.

**9.4** After expiry of the Warranty Period, all support, bug-fixing, and maintenance shall be chargeable, whether under an Annual Maintenance Contract (Clause 10) or on a time-and-material basis as separately agreed.

---

## 10. Post-Warranty Maintenance (AMC)

**10.1** The Developer may, at the Client's request, offer an Annual Maintenance Contract covering post-Warranty bug-fixing, monitoring, and minor support, on terms (including price) to be discussed and agreed separately in writing after the Warranty Period, or earlier if both Parties wish.

**10.2** No AMC terms are included or implied in this Agreement. The absence of an AMC does not extend the Warranty Period in Clause 9.

---

## 11. Intellectual Property Rights

**11.1** Subject to full and final payment of the Total Contract Value (including all instalments under Clause 5.2 and any Change Requests under Clause 6), all right, title, and interest in the source code, documentation, and other Deliverables **created specifically for the Client under this Agreement** shall vest in and transfer to the Client.

**11.2** Until such full and final payment is received, all Deliverables and underlying IP shall remain the sole property of the Developer, notwithstanding delivery, deployment, or use.

**11.3** The transfer in Clause 11.1 does not extend to: (a) the Developer's pre-existing tools, frameworks, libraries, boilerplate, or generic reusable components not created specifically for this project, in which the Developer retains ownership but grants the Client a perpetual, royalty-free, non-exclusive licence to use as part of the Platform; and (b) third-party and open-source components, which remain governed by their respective licences.

**11.4** The Developer warrants that, to the best of its knowledge, the Deliverables (excluding third-party/open-source components) do not infringe the intellectual property rights of any third party.

---

## 12. Confidentiality

**12.1** Each Party shall keep confidential all non-public business, technical, and financial information disclosed by the other Party in connection with this Agreement ("Confidential Information"), and shall use it solely for the purposes of this Agreement.

**12.2** Confidential Information does not include information that: is or becomes publicly available through no fault of the receiving Party; was already lawfully known to the receiving Party before disclosure; or is required to be disclosed by law or a competent court/regulatory authority, provided the disclosing Party is given prior written notice where legally permissible.

**12.3** This Clause survives termination or expiry of this Agreement for a period of **2 (two) years**.

---

## 13. Data Protection

**13.1** The Client warrants that it has, and will maintain, a valid legal basis to provide the Developer with any personal data processed in connection with the Platform, and that its use of the Platform complies with the Digital Personal Data Protection Act, 2023, the Information Technology Act, 2000, and rules made thereunder.

**13.2** The Developer shall implement reasonable technical and organizational measures to protect data processed by the Platform, consistent with the design described in Schedule A (including tenant-level data isolation), but does not act as a data fiduciary for the Client's End Customers' data and processes it solely on the Client's instructions as a service provider.

---

## 14. Limitation of Liability

**14.1** Neither Party shall be liable to the other for any indirect, incidental, special, or consequential loss, including loss of profit, revenue, or data, arising out of or in connection with this Agreement.

**14.2** The Developer's aggregate liability under or in connection with this Agreement, whether in contract, tort, or otherwise, shall not exceed the Total Contract Value actually paid by the Client under Clause 5.1.

**14.3** Nothing in this Clause limits either Party's liability for fraud, wilful misconduct, or gross negligence, or any liability that cannot be excluded or limited under applicable Indian law.

---

## 15. Indemnification

Each Party shall indemnify and hold harmless the other Party against direct losses, damages, and reasonable costs arising from: (a) the indemnifying Party's breach of Clause 12 (Confidentiality); or (b) a third-party claim that the indemnifying Party's material (in the Developer's case, the Deliverables excluding third-party components; in the Client's case, data, content, or instructions provided to the Developer) infringes that third party's intellectual property rights, subject to the liability cap in Clause 14.2.

---

## 16. Force Majeure

Neither Party shall be liable for any failure or delay in performance caused by circumstances beyond its reasonable control, including acts of God, fire, flood, war, riot, strike, epidemic/pandemic, governmental action, or internet/telecom/cloud-provider outage, provided the affected Party promptly notifies the other Party and resumes performance as soon as reasonably practicable.

---

## 17. Term & Termination

**17.1** This Agreement commences on the Effective Date and continues until completion of Handover and expiry of the Warranty Period under Clause 9, unless terminated earlier under this Clause.

**17.2** Either Party may terminate this Agreement for material breach by the other Party that remains uncured for **15 (fifteen) days** after written notice specifying the breach.

**17.3** The Client may terminate this Agreement for convenience on 7 days' written notice. In such event: (a) the Developer shall be paid for all work performed up to the effective date of termination, calculated pro-rata against the work-stream allocation in Clause 5.1, in addition to any instalment already due under Clause 5.2; and (b) any instalment already paid is non-refundable.

**17.4** On termination for any reason, each Party shall return or destroy the other Party's Confidential Information, and the Developer shall hand over all work-in-progress Deliverables paid for as of the termination date.

---

## 18. Representations & Warranties

**18.1** Each Party represents that it has full power and authority to enter into and perform this Agreement.

**18.2** The Developer warrants that the Deliverables will be provided using reasonable skill and care consistent with prevailing industry practice.

**18.3** Except as expressly stated in this Agreement, the Platform is provided without any other warranty, express or implied, including any implied warranty of merchantability or fitness for a particular purpose, to the extent permitted under applicable Indian law.

---

## 19. Governing Law & Dispute Resolution

**19.1** This Agreement is governed by the laws of India.

**19.2** Any dispute arising out of or in connection with this Agreement shall first be referred to good-faith discussion between the Parties' authorized representatives for a period of **15 (fifteen) days**.

**19.3** If unresolved, the dispute shall be referred to and finally resolved by arbitration under the Arbitration and Conciliation Act, 1996, by a sole arbitrator mutually appointed by the Parties. The seat and venue of arbitration shall be **[City]**, India, and the language of arbitration shall be English.

**19.4** Subject to Clause 19.3, the courts at **[City]** shall have exclusive jurisdiction over matters not referable to arbitration (e.g., interim relief).

**19.5** This Agreement is subject to stamping in accordance with the applicable state Stamp Act, and the Parties shall bear stamp duty as mutually agreed / as required by law.

---

## 20. Miscellaneous

**20.1 Entire Agreement.** This Agreement, together with its Schedules, constitutes the entire agreement between the Parties on its subject matter and supersedes all prior discussions, understandings, or agreements, written or oral.

**20.2 Amendment.** No amendment or waiver of any term of this Agreement shall be effective unless in writing and signed by authorized representatives of both Parties.

**20.3 Assignment.** Neither Party may assign or transfer this Agreement, in whole or in part, without the prior written consent of the other Party, except that the Developer may subcontract specific development tasks while remaining responsible for their performance.

**20.4 Severability.** If any provision of this Agreement is held invalid or unenforceable, the remaining provisions shall continue in full force and effect.

**20.5 Notices.** All notices under this Agreement shall be in writing and delivered by email (with read receipt or reply acknowledgment) or registered post to the addresses set out in the preamble, or such other address as either Party may notify in writing.

**20.6 Independent Contractors.** Nothing in this Agreement creates a partnership, joint venture, agency, or employment relationship between the Parties.

**20.7 Counterparts.** This Agreement may be executed in counterparts (including by electronic signature/DSC), each of which shall be deemed an original.

---

## Signatures

**For and on behalf of the Developer**

Name: ______________________
Designation: ______________________
Date: ______________________
Signature: ______________________

**For and on behalf of the Client**

Name: ______________________
Designation: ______________________
Date: ______________________
Signature: ______________________

---

*Note: This draft is prepared for commercial negotiation purposes. Items in [brackets] must be filled in before execution. It is recommended that this Agreement be reviewed by a qualified advocate and executed on appropriate non-judicial stamp paper (or e-stamped) per the applicable state Stamp Act before signature, to ensure enforceability and admissibility as evidence under the Indian Stamp Act, 1899 / applicable state legislation.*
