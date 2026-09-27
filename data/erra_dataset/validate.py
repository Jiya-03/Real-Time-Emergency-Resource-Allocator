import pandas as pd, sys
D='out/'
L=lambda n: pd.read_csv(D+n, keep_default_na=True)
r,h,hr,hs,a,uh,rs,wf,mr=[L(x) for x in ["emergency_requests.csv","hospitals.csv","hospital_resources.csv","hospital_services.csv","ambulances.csv","resource_update_history.csv","reservations.csv","emergency_workflow_handover.csv","match_ranking_results.csv"]]
ok=True
def chk(c,msg):
    global ok
    print(("PASS " if c else "FAIL ")+msg); ok&=bool(c)
for df,pk in [(r,'request_id'),(h,'hospital_id'),(hr,'resource_record_id'),(hs,'service_record_id'),(a,'ambulance_id'),(uh,'update_id'),(rs,'reservation_id'),(wf,'workflow_id'),(mr,'match_id')]:
    chk(df[pk].is_unique and df[pk].notna().all(), f"PK unique {pk}"); chk(not df.drop(columns=pk).duplicated().any(), f"no dup rows ({pk})")
H=set(h.hospital_id); R=set(r.request_id); A=set(a.ambulance_id)
for df,n in [(hr,'hr'),(hs,'hs'),(uh,'uh'),(rs,'rs'),(wf,'wf'),(mr,'mr')]: chk(df.hospital_id.isin(H).all(), f"FK hospital {n}")
for df,n in [(rs,'rs'),(wf,'wf'),(mr,'mr')]: chk(df.request_id.isin(R).all(), f"FK request {n}")
chk(r.ambulance_id.dropna().isin(A).all(),"FK ambulance in requests"); chk(wf.ambulance_id.isin(A).all(),"FK ambulance in workflow")
chk(a.current_request_id.dropna().isin(R).all(),"FK ambulance.current_request_id")
for k in ['icu_beds','ventilators','oxygen_beds','general_beds']:
    chk(((hr['available_'+k]>=0)&(hr['available_'+k]<=hr['total_'+k])).all(), f"0<=available<=total {k}")
tot=hr.set_index('hospital_id'); mp={'ICU':'total_icu_beds','Ventilator':'total_ventilators','Oxygen Bed':'total_oxygen_beds','General Bed':'total_general_beds'}
uh['tot']=[tot.at[x,mp[t]] for x,t in zip(uh.hospital_id,uh.resource_type)]
chk(((uh.old_available_count.between(0,uh.tot))&(uh.new_available_count.between(0,uh.tot))).all(),"history counts within [0,total]")
chk((uh.old_available_count!=uh.new_available_count).all(),"history rows are real changes")
# chain continuity & ends at snapshot
u2=uh.sort_values(['hospital_id','resource_type','updated_at','update_id'])
cont=all((g.old_available_count.values[1:]==g.new_available_count.values[:-1]).all() for _,g in u2.groupby(['hospital_id','resource_type']))
chk(cont,"history chains continuous")
av={'ICU':'available_icu_beds','Ventilator':'available_ventilators','Oxygen Bed':'available_oxygen_beds','General Bed':'available_general_beds'}
last=u2.groupby(['hospital_id','resource_type']).tail(1)
chk(all(tot.at[x,av[t]]==v for x,t,v in zip(last.hospital_id,last.resource_type,last.new_available_count)),"history final value == current snapshot")
chk((last.updated_at<=last.hospital_id.map(tot.last_updated_timestamp)).all(),"history not after snapshot timestamp")
rs['tot']=[tot.at[x,mp[t]] for x,t in zip(rs.hospital_id,rs.resource_type)]
chk((rs.tot>0).all(),"no reservations for resources a hospital doesn't have")
chk((rs.quantity>0).all(),"reservation qty>0")
c=rs.confirmed_at.notna(); chk((rs.confirmed_at[c]>=rs.requested_at[c]).all(),"confirmed_at>=requested_at"); chk((rs.expires_at>rs.requested_at).all(),"expires_at>requested_at")
chk(rs[rs.reservation_status.isin(['FAILED','EXPIRED','PENDING'])].confirmed_at.isna().all(),"FAILED/EXPIRED/PENDING have no confirmed_at")
t=wf[['assignment_time','departure_time','arrival_time','handover_time']]
seq=True
for row in t.itertuples(index=False):
    v=[x for x in row if isinstance(x,str)]
    seq&= v==sorted(v) and all(isinstance(row[i],str) for i in range(len(v)))
chk(seq,"workflow timestamp order + no gaps")
rej=wf[wf.hospital_response=='REJECTED']; chk(rej.rejection_reason.notna().all() and rej.departure_time.isna().all(),"rejected rows: reason set, later times NULL")
chk(wf[wf.hospital_response!='REJECTED'].rejection_reason.isna().all(),"non-rejected rows: no rejection reason")
chk((wf[wf.handover_status=='COMPLETED'].handover_time.notna()).all(),"COMPLETED has handover_time")
# ambulance overlap
st=r.set_index('request_id').request_status
g=wf.groupby('request_id').agg(amb=('ambulance_id','first'),s=('assignment_time','min'),h=('handover_time','max'),la=('assignment_time','max')).reset_index()
g['e']=[h_ if isinstance(h_,str) else (la if st[q]=='NO_MATCH' else '2099') for q,h_,la in zip(g.request_id,g.h,g.la)]
g=g.sort_values(['amb','s'])
ov=any((grp.s.values[1:]<grp.e.values[:-1]).any() for _,grp in g.groupby('amb'))
chk(not ov,"no ambulance serves overlapping requests")
b=a[a.availability_status=='BUSY']; chk(b.current_request_id.notna().all() and a[a.availability_status!='BUSY'].current_request_id.isna().all(),"BUSY <=> current_request_id")
rr=r.set_index('request_id'); chk(all(rr.at[q,'ambulance_id']==x for q,x in zip(b.current_request_id,b.ambulance_id)),"busy ambulance matches request.ambulance_id")
chk(all(rr.at[q,'request_status'] in ('ASSIGNED','IN_TRANSIT','MATCHING') for q in b.current_request_id),"busy ambulance request is active")
for col in ['resource_match_score','freshness_score','final_suitability_score']: chk(mr[col].between(0,1).all(), f"{col} in [0,1]")
chk((mr.distance_km>=0).all() and (mr.estimated_travel_time_min>0).all(),"distance/time valid")
top=mr[mr['rank']==1]; e=mr.groupby('request_id').eligibility.any()
chk(all(top.set_index('request_id').eligibility[q]==e[q] for q in e.index),"eligible hospitals always outrank ineligible")
# accepted hospital must be eligible in ranking
m=mr.set_index(['request_id','hospital_id']).eligibility
acc=wf[wf.hospital_response=='ACCEPTED']; chk(all(m.get((q,x),False) for q,x in zip(acc.request_id,acc.hospital_id)),"accepted hospital was eligible in ranking")
chk(r.patient_latitude.between(18.3,18.9).all() and r.patient_longitude.between(73.5,74.2).all(),"coords in Pune region")
chk(r.request_status[~r.request_id.isin(wf.request_id)].isin(['CREATED','MATCHING','NO_MATCH']).all(),"only workflow requests have completed states")
chk(r.ambulance_id.notna().sum()==r.request_id.isin(wf.request_id).sum(),"ambulance set only for dispatched requests")
print("\nALL CHECKS PASSED" if ok else "\nSOME CHECKS FAILED"); sys.exit(0 if ok else 1)
