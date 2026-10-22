---------------- MODULE Current ----------------
EXTENDS Naturals, TLC

VARIABLES loc, v_captured_plan_a_9417933448, v_live_plan_a_dec6cd1b41, v_candidate_plan_a_1a16e1a630, v_captured_source_a_6917a1844f, v_live_source_a_8cf7bc1e5f, v_candidate_source_a_647c2e0a35, v_captured_plan_b_c72aa0215b, v_live_plan_b_9454ee545e, v_candidate_plan_b_94f1436f8c, v_captured_source_b_2f4bfd4ffa, v_live_source_b_8ffc36fecc, v_candidate_source_b_ea195f6042
vars == <<loc, v_captured_plan_a_9417933448, v_live_plan_a_dec6cd1b41, v_candidate_plan_a_1a16e1a630, v_captured_source_a_6917a1844f, v_live_source_a_8cf7bc1e5f, v_candidate_source_a_647c2e0a35, v_captured_plan_b_c72aa0215b, v_live_plan_b_9454ee545e, v_candidate_plan_b_94f1436f8c, v_captured_source_b_2f4bfd4ffa, v_live_source_b_8ffc36fecc, v_candidate_source_b_ea195f6042>>

Init ==
  /\ loc = 0
  /\ v_captured_plan_a_9417933448 = 0
  /\ v_live_plan_a_dec6cd1b41 = 0
  /\ v_candidate_plan_a_1a16e1a630 = 0
  /\ v_captured_source_a_6917a1844f = 0
  /\ v_live_source_a_8cf7bc1e5f = 0
  /\ v_candidate_source_a_647c2e0a35 = 0
  /\ v_captured_plan_b_c72aa0215b = 0
  /\ v_live_plan_b_9454ee545e = 0
  /\ v_candidate_plan_b_94f1436f8c = 0
  /\ v_captured_source_b_2f4bfd4ffa = 0
  /\ v_live_source_b_8ffc36fecc = 0
  /\ v_candidate_source_b_ea195f6042 = 0

TypeOK ==
  /\ loc \in {0, 1, 2, 3, 4, 5, 6, 7, 8}
  /\ v_captured_plan_a_9417933448 \in {0, 1}
  /\ v_live_plan_a_dec6cd1b41 \in {0, 1}
  /\ v_candidate_plan_a_1a16e1a630 \in {0, 1}
  /\ v_captured_source_a_6917a1844f \in {0, 1}
  /\ v_live_source_a_8cf7bc1e5f \in {0, 1}
  /\ v_candidate_source_a_647c2e0a35 \in {0, 1}
  /\ v_captured_plan_b_c72aa0215b \in {0, 1}
  /\ v_live_plan_b_9454ee545e \in {0, 1}
  /\ v_candidate_plan_b_94f1436f8c \in {0, 1}
  /\ v_captured_source_b_2f4bfd4ffa \in {0, 1}
  /\ v_live_source_b_8ffc36fecc \in {0, 1}
  /\ v_candidate_source_b_ea195f6042 \in {0, 1}

Step_admit_and_capture_70bfc644b1 ==
  /\ loc = 0
  /\ (TRUE)
  /\ loc' = 1
  /\ v_captured_plan_a_9417933448' = v_live_plan_a_dec6cd1b41
  /\ v_live_plan_a_dec6cd1b41' = v_live_plan_a_dec6cd1b41
  /\ v_candidate_plan_a_1a16e1a630' = v_candidate_plan_a_1a16e1a630
  /\ v_captured_source_a_6917a1844f' = v_live_source_a_8cf7bc1e5f
  /\ v_live_source_a_8cf7bc1e5f' = v_live_source_a_8cf7bc1e5f
  /\ v_candidate_source_a_647c2e0a35' = v_candidate_source_a_647c2e0a35
  /\ v_captured_plan_b_c72aa0215b' = v_live_plan_b_9454ee545e
  /\ v_live_plan_b_9454ee545e' = v_live_plan_b_9454ee545e
  /\ v_candidate_plan_b_94f1436f8c' = v_candidate_plan_b_94f1436f8c
  /\ v_captured_source_b_2f4bfd4ffa' = v_live_source_b_8ffc36fecc
  /\ v_live_source_b_8ffc36fecc' = v_live_source_b_8ffc36fecc
  /\ v_candidate_source_b_ea195f6042' = v_candidate_source_b_ea195f6042

Step_complete_synthesis_a_519acd4ba6 ==
  /\ loc = 1
  /\ (TRUE)
  /\ loc' = 2
  /\ v_captured_plan_a_9417933448' = v_captured_plan_a_9417933448
  /\ v_live_plan_a_dec6cd1b41' = v_live_plan_a_dec6cd1b41
  /\ v_candidate_plan_a_1a16e1a630' = v_captured_plan_a_9417933448
  /\ v_captured_source_a_6917a1844f' = v_captured_source_a_6917a1844f
  /\ v_live_source_a_8cf7bc1e5f' = v_live_source_a_8cf7bc1e5f
  /\ v_candidate_source_a_647c2e0a35' = v_captured_source_a_6917a1844f
  /\ v_captured_plan_b_c72aa0215b' = v_captured_plan_b_c72aa0215b
  /\ v_live_plan_b_9454ee545e' = v_live_plan_b_9454ee545e
  /\ v_candidate_plan_b_94f1436f8c' = v_candidate_plan_b_94f1436f8c
  /\ v_captured_source_b_2f4bfd4ffa' = v_captured_source_b_2f4bfd4ffa
  /\ v_live_source_b_8ffc36fecc' = v_live_source_b_8ffc36fecc
  /\ v_candidate_source_b_ea195f6042' = v_candidate_source_b_ea195f6042

Step_complete_synthesis_b_ad111fef1c ==
  /\ loc = 2
  /\ (TRUE)
  /\ loc' = 3
  /\ v_captured_plan_a_9417933448' = v_captured_plan_a_9417933448
  /\ v_live_plan_a_dec6cd1b41' = v_live_plan_a_dec6cd1b41
  /\ v_candidate_plan_a_1a16e1a630' = v_candidate_plan_a_1a16e1a630
  /\ v_captured_source_a_6917a1844f' = v_captured_source_a_6917a1844f
  /\ v_live_source_a_8cf7bc1e5f' = v_live_source_a_8cf7bc1e5f
  /\ v_candidate_source_a_647c2e0a35' = v_candidate_source_a_647c2e0a35
  /\ v_captured_plan_b_c72aa0215b' = v_captured_plan_b_c72aa0215b
  /\ v_live_plan_b_9454ee545e' = v_live_plan_b_9454ee545e
  /\ v_candidate_plan_b_94f1436f8c' = v_captured_plan_b_c72aa0215b
  /\ v_captured_source_b_2f4bfd4ffa' = v_captured_source_b_2f4bfd4ffa
  /\ v_live_source_b_8ffc36fecc' = v_live_source_b_8ffc36fecc
  /\ v_candidate_source_b_ea195f6042' = v_captured_source_b_2f4bfd4ffa

Step_repo_a_source_check_08c8065c84 ==
  /\ loc = 3
  /\ (v_live_source_a_8cf7bc1e5f = v_candidate_source_a_647c2e0a35)
  /\ loc' = 4
  /\ v_captured_plan_a_9417933448' = v_captured_plan_a_9417933448
  /\ v_live_plan_a_dec6cd1b41' = v_live_plan_a_dec6cd1b41
  /\ v_candidate_plan_a_1a16e1a630' = v_candidate_plan_a_1a16e1a630
  /\ v_captured_source_a_6917a1844f' = v_captured_source_a_6917a1844f
  /\ v_live_source_a_8cf7bc1e5f' = v_live_source_a_8cf7bc1e5f
  /\ v_candidate_source_a_647c2e0a35' = v_candidate_source_a_647c2e0a35
  /\ v_captured_plan_b_c72aa0215b' = v_captured_plan_b_c72aa0215b
  /\ v_live_plan_b_9454ee545e' = v_live_plan_b_9454ee545e
  /\ v_candidate_plan_b_94f1436f8c' = v_candidate_plan_b_94f1436f8c
  /\ v_captured_source_b_2f4bfd4ffa' = v_captured_source_b_2f4bfd4ffa
  /\ v_live_source_b_8ffc36fecc' = v_live_source_b_8ffc36fecc
  /\ v_candidate_source_b_ea195f6042' = v_candidate_source_b_ea195f6042

Step_repo_a_source_check_rejects_e01390280d ==
  /\ loc = 3
  /\ (v_live_source_a_8cf7bc1e5f # v_candidate_source_a_647c2e0a35)
  /\ loc' = 8
  /\ v_captured_plan_a_9417933448' = v_captured_plan_a_9417933448
  /\ v_live_plan_a_dec6cd1b41' = v_live_plan_a_dec6cd1b41
  /\ v_candidate_plan_a_1a16e1a630' = v_candidate_plan_a_1a16e1a630
  /\ v_captured_source_a_6917a1844f' = v_captured_source_a_6917a1844f
  /\ v_live_source_a_8cf7bc1e5f' = v_live_source_a_8cf7bc1e5f
  /\ v_candidate_source_a_647c2e0a35' = v_candidate_source_a_647c2e0a35
  /\ v_captured_plan_b_c72aa0215b' = v_captured_plan_b_c72aa0215b
  /\ v_live_plan_b_9454ee545e' = v_live_plan_b_9454ee545e
  /\ v_candidate_plan_b_94f1436f8c' = v_candidate_plan_b_94f1436f8c
  /\ v_captured_source_b_2f4bfd4ffa' = v_captured_source_b_2f4bfd4ffa
  /\ v_live_source_b_8ffc36fecc' = v_live_source_b_8ffc36fecc
  /\ v_candidate_source_b_ea195f6042' = v_candidate_source_b_ea195f6042

Step_begin_repo_b_context_await_afbbe1585f ==
  /\ loc = 4
  /\ (TRUE)
  /\ loc' = 5
  /\ v_captured_plan_a_9417933448' = v_captured_plan_a_9417933448
  /\ v_live_plan_a_dec6cd1b41' = v_live_plan_a_dec6cd1b41
  /\ v_candidate_plan_a_1a16e1a630' = v_candidate_plan_a_1a16e1a630
  /\ v_captured_source_a_6917a1844f' = v_captured_source_a_6917a1844f
  /\ v_live_source_a_8cf7bc1e5f' = v_live_source_a_8cf7bc1e5f
  /\ v_candidate_source_a_647c2e0a35' = v_candidate_source_a_647c2e0a35
  /\ v_captured_plan_b_c72aa0215b' = v_captured_plan_b_c72aa0215b
  /\ v_live_plan_b_9454ee545e' = v_live_plan_b_9454ee545e
  /\ v_candidate_plan_b_94f1436f8c' = v_candidate_plan_b_94f1436f8c
  /\ v_captured_source_b_2f4bfd4ffa' = v_captured_source_b_2f4bfd4ffa
  /\ v_live_source_b_8ffc36fecc' = v_live_source_b_8ffc36fecc
  /\ v_candidate_source_b_ea195f6042' = v_candidate_source_b_ea195f6042

Step_edit_repo_a_plan_during_repo_b_c_99890eb93d ==
  /\ loc = 5
  /\ (v_live_plan_a_dec6cd1b41 = 0)
  /\ loc' = 5
  /\ v_captured_plan_a_9417933448' = v_captured_plan_a_9417933448
  /\ v_live_plan_a_dec6cd1b41' = 1
  /\ v_candidate_plan_a_1a16e1a630' = v_candidate_plan_a_1a16e1a630
  /\ v_captured_source_a_6917a1844f' = v_captured_source_a_6917a1844f
  /\ v_live_source_a_8cf7bc1e5f' = v_live_source_a_8cf7bc1e5f
  /\ v_candidate_source_a_647c2e0a35' = v_candidate_source_a_647c2e0a35
  /\ v_captured_plan_b_c72aa0215b' = v_captured_plan_b_c72aa0215b
  /\ v_live_plan_b_9454ee545e' = v_live_plan_b_9454ee545e
  /\ v_candidate_plan_b_94f1436f8c' = v_candidate_plan_b_94f1436f8c
  /\ v_captured_source_b_2f4bfd4ffa' = v_captured_source_b_2f4bfd4ffa
  /\ v_live_source_b_8ffc36fecc' = v_live_source_b_8ffc36fecc
  /\ v_candidate_source_b_ea195f6042' = v_candidate_source_b_ea195f6042

Step_external_filesystem_edit_a_durin_2601f1daec ==
  /\ loc = 5
  /\ (v_live_source_a_8cf7bc1e5f = 0)
  /\ loc' = 5
  /\ v_captured_plan_a_9417933448' = v_captured_plan_a_9417933448
  /\ v_live_plan_a_dec6cd1b41' = v_live_plan_a_dec6cd1b41
  /\ v_candidate_plan_a_1a16e1a630' = v_candidate_plan_a_1a16e1a630
  /\ v_captured_source_a_6917a1844f' = v_captured_source_a_6917a1844f
  /\ v_live_source_a_8cf7bc1e5f' = 1
  /\ v_candidate_source_a_647c2e0a35' = v_candidate_source_a_647c2e0a35
  /\ v_captured_plan_b_c72aa0215b' = v_captured_plan_b_c72aa0215b
  /\ v_live_plan_b_9454ee545e' = v_live_plan_b_9454ee545e
  /\ v_candidate_plan_b_94f1436f8c' = v_candidate_plan_b_94f1436f8c
  /\ v_captured_source_b_2f4bfd4ffa' = v_captured_source_b_2f4bfd4ffa
  /\ v_live_source_b_8ffc36fecc' = v_live_source_b_8ffc36fecc
  /\ v_candidate_source_b_ea195f6042' = v_candidate_source_b_ea195f6042

Step_repo_b_context_and_source_check_46bd9be97a ==
  /\ loc = 5
  /\ (v_live_source_b_8ffc36fecc = v_candidate_source_b_ea195f6042)
  /\ loc' = 6
  /\ v_captured_plan_a_9417933448' = v_captured_plan_a_9417933448
  /\ v_live_plan_a_dec6cd1b41' = v_live_plan_a_dec6cd1b41
  /\ v_candidate_plan_a_1a16e1a630' = v_candidate_plan_a_1a16e1a630
  /\ v_captured_source_a_6917a1844f' = v_captured_source_a_6917a1844f
  /\ v_live_source_a_8cf7bc1e5f' = v_live_source_a_8cf7bc1e5f
  /\ v_candidate_source_a_647c2e0a35' = v_candidate_source_a_647c2e0a35
  /\ v_captured_plan_b_c72aa0215b' = v_captured_plan_b_c72aa0215b
  /\ v_live_plan_b_9454ee545e' = v_live_plan_b_9454ee545e
  /\ v_candidate_plan_b_94f1436f8c' = v_candidate_plan_b_94f1436f8c
  /\ v_captured_source_b_2f4bfd4ffa' = v_captured_source_b_2f4bfd4ffa
  /\ v_live_source_b_8ffc36fecc' = v_live_source_b_8ffc36fecc
  /\ v_candidate_source_b_ea195f6042' = v_candidate_source_b_ea195f6042

Step_repo_b_source_check_rejects_3fd72a9755 ==
  /\ loc = 5
  /\ (v_live_source_b_8ffc36fecc # v_candidate_source_b_ea195f6042)
  /\ loc' = 8
  /\ v_captured_plan_a_9417933448' = v_captured_plan_a_9417933448
  /\ v_live_plan_a_dec6cd1b41' = v_live_plan_a_dec6cd1b41
  /\ v_candidate_plan_a_1a16e1a630' = v_candidate_plan_a_1a16e1a630
  /\ v_captured_source_a_6917a1844f' = v_captured_source_a_6917a1844f
  /\ v_live_source_a_8cf7bc1e5f' = v_live_source_a_8cf7bc1e5f
  /\ v_candidate_source_a_647c2e0a35' = v_candidate_source_a_647c2e0a35
  /\ v_captured_plan_b_c72aa0215b' = v_captured_plan_b_c72aa0215b
  /\ v_live_plan_b_9454ee545e' = v_live_plan_b_9454ee545e
  /\ v_candidate_plan_b_94f1436f8c' = v_candidate_plan_b_94f1436f8c
  /\ v_captured_source_b_2f4bfd4ffa' = v_captured_source_b_2f4bfd4ffa
  /\ v_live_source_b_8ffc36fecc' = v_live_source_b_8ffc36fecc
  /\ v_candidate_source_b_ea195f6042' = v_candidate_source_b_ea195f6042

Step_workspace_plan_fence_publishes_a8fdb74b4f ==
  /\ loc = 6
  /\ ((v_live_plan_a_dec6cd1b41 = v_candidate_plan_a_1a16e1a630 /\ v_live_plan_b_9454ee545e = v_candidate_plan_b_94f1436f8c))
  /\ loc' = 7
  /\ v_captured_plan_a_9417933448' = v_captured_plan_a_9417933448
  /\ v_live_plan_a_dec6cd1b41' = v_live_plan_a_dec6cd1b41
  /\ v_candidate_plan_a_1a16e1a630' = v_candidate_plan_a_1a16e1a630
  /\ v_captured_source_a_6917a1844f' = v_captured_source_a_6917a1844f
  /\ v_live_source_a_8cf7bc1e5f' = v_live_source_a_8cf7bc1e5f
  /\ v_candidate_source_a_647c2e0a35' = v_candidate_source_a_647c2e0a35
  /\ v_captured_plan_b_c72aa0215b' = v_captured_plan_b_c72aa0215b
  /\ v_live_plan_b_9454ee545e' = v_live_plan_b_9454ee545e
  /\ v_candidate_plan_b_94f1436f8c' = v_candidate_plan_b_94f1436f8c
  /\ v_captured_source_b_2f4bfd4ffa' = v_captured_source_b_2f4bfd4ffa
  /\ v_live_source_b_8ffc36fecc' = v_live_source_b_8ffc36fecc
  /\ v_candidate_source_b_ea195f6042' = v_candidate_source_b_ea195f6042

Step_workspace_plan_fence_rejects_40b0cdc91c ==
  /\ loc = 6
  /\ ((v_live_plan_a_dec6cd1b41 # v_candidate_plan_a_1a16e1a630 \/ v_live_plan_b_9454ee545e # v_candidate_plan_b_94f1436f8c))
  /\ loc' = 8
  /\ v_captured_plan_a_9417933448' = v_captured_plan_a_9417933448
  /\ v_live_plan_a_dec6cd1b41' = v_live_plan_a_dec6cd1b41
  /\ v_candidate_plan_a_1a16e1a630' = v_candidate_plan_a_1a16e1a630
  /\ v_captured_source_a_6917a1844f' = v_captured_source_a_6917a1844f
  /\ v_live_source_a_8cf7bc1e5f' = v_live_source_a_8cf7bc1e5f
  /\ v_candidate_source_a_647c2e0a35' = v_candidate_source_a_647c2e0a35
  /\ v_captured_plan_b_c72aa0215b' = v_captured_plan_b_c72aa0215b
  /\ v_live_plan_b_9454ee545e' = v_live_plan_b_9454ee545e
  /\ v_candidate_plan_b_94f1436f8c' = v_candidate_plan_b_94f1436f8c
  /\ v_captured_source_b_2f4bfd4ffa' = v_captured_source_b_2f4bfd4ffa
  /\ v_live_source_b_8ffc36fecc' = v_live_source_b_8ffc36fecc
  /\ v_candidate_source_b_ea195f6042' = v_candidate_source_b_ea195f6042

Step_external_filesystem_edit_a_after_49e5ce673f ==
  /\ loc = 7
  /\ (v_live_source_a_8cf7bc1e5f = 0)
  /\ loc' = 7
  /\ v_captured_plan_a_9417933448' = v_captured_plan_a_9417933448
  /\ v_live_plan_a_dec6cd1b41' = v_live_plan_a_dec6cd1b41
  /\ v_candidate_plan_a_1a16e1a630' = v_candidate_plan_a_1a16e1a630
  /\ v_captured_source_a_6917a1844f' = v_captured_source_a_6917a1844f
  /\ v_live_source_a_8cf7bc1e5f' = 1
  /\ v_candidate_source_a_647c2e0a35' = v_candidate_source_a_647c2e0a35
  /\ v_captured_plan_b_c72aa0215b' = v_captured_plan_b_c72aa0215b
  /\ v_live_plan_b_9454ee545e' = v_live_plan_b_9454ee545e
  /\ v_candidate_plan_b_94f1436f8c' = v_candidate_plan_b_94f1436f8c
  /\ v_captured_source_b_2f4bfd4ffa' = v_captured_source_b_2f4bfd4ffa
  /\ v_live_source_b_8ffc36fecc' = v_live_source_b_8ffc36fecc
  /\ v_candidate_source_b_ea195f6042' = v_candidate_source_b_ea195f6042

Next ==
  \/ Step_admit_and_capture_70bfc644b1
  \/ Step_complete_synthesis_a_519acd4ba6
  \/ Step_complete_synthesis_b_ad111fef1c
  \/ Step_repo_a_source_check_08c8065c84
  \/ Step_repo_a_source_check_rejects_e01390280d
  \/ Step_begin_repo_b_context_await_afbbe1585f
  \/ Step_edit_repo_a_plan_during_repo_b_c_99890eb93d
  \/ Step_external_filesystem_edit_a_durin_2601f1daec
  \/ Step_repo_b_context_and_source_check_46bd9be97a
  \/ Step_repo_b_source_check_rejects_3fd72a9755
  \/ Step_workspace_plan_fence_publishes_a8fdb74b4f
  \/ Step_workspace_plan_fence_rejects_40b0cdc91c
  \/ Step_external_filesystem_edit_a_after_49e5ce673f

Spec == Init /\ [][Next]_vars

Invariant_published_plans_match_captured_r_5665aa10c0 == loc \in {7} => ((v_candidate_plan_a_1a16e1a630 = v_captured_plan_a_9417933448 /\ v_candidate_plan_b_94f1436f8c = v_captured_plan_b_c72aa0215b /\ v_live_plan_a_dec6cd1b41 = v_candidate_plan_a_1a16e1a630 /\ v_live_plan_b_9454ee545e = v_candidate_plan_b_94f1436f8c))
Invariant_published_candidate_retains_capt_6803763574 == loc \in {7} => ((v_candidate_source_a_647c2e0a35 = v_captured_source_a_6917a1844f /\ v_candidate_source_b_ea195f6042 = v_captured_source_b_2f4bfd4ffa))

=======================================================
